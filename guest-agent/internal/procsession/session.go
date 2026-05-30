// Package procsession manages long-running subprocesses with stdin/stdout pipes.
package procsession

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/Adamkadaban/crucible/guest-agent/internal/audit"
)

const (
	defaultCommandWaitMs = 750
	maxCommandWaitMs     = 30_000
	maxCommandBytes      = 32 * 1024
	maxResponseBytes     = 4 * 1024 * 1024
)

type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	baseDir  string
}

type Session struct {
	id        string
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	logPath   string
	started   time.Time
	mu        sync.Mutex
	buffer    []byte
	truncated bool
	done      chan error
}

type openRequest struct {
	Executable       string            `json:"executable"`
	Arguments        []string          `json:"arguments,omitempty"`
	WorkingDirectory string            `json:"workingDirectory,omitempty"`
	Environment      map[string]string `json:"environment,omitempty"`
	LogPath          string            `json:"logPath,omitempty"`
}

type openResponse struct {
	ID        string `json:"id"`
	PID       int    `json:"pid"`
	LogPath   string `json:"logPath"`
	StartedAt string `json:"startedAt"`
}

type commandRequest struct {
	ID     string `json:"id"`
	Input  string `json:"input"`
	WaitMs int    `json:"waitMs,omitempty"`
}

type commandResponse struct {
	ID           string `json:"id"`
	OutputBase64 string `json:"outputBase64,omitempty"`
	Truncated    bool   `json:"truncated"`
	LogPath      string `json:"logPath"`
	Exited       bool   `json:"exited"`
	ExitError    string `json:"exitError,omitempty"`
}

type closeRequest struct {
	ID string `json:"id"`
}

type closeResponse struct {
	ID      string `json:"id"`
	Closed  bool   `json:"closed"`
	LogPath string `json:"logPath,omitempty"`
}

func NewManager(baseDir string) *Manager {
	if baseDir == "" {
		baseDir = os.TempDir()
	}
	return &Manager{sessions: map[string]*Session{}, baseDir: baseDir}
}

func (m *Manager) OpenHandler(auditor *audit.Auditor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req openRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "decode body: "+err.Error(), http.StatusBadRequest)
			return
		}
		session, err := m.Open(r.Context(), req)
		if err != nil {
			http.Error(w, "open session: "+err.Error(), http.StatusInternalServerError)
			return
		}
		resp := openResponse{ID: session.id, PID: session.cmd.Process.Pid, LogPath: session.logPath, StartedAt: session.started.Format(time.RFC3339Nano)}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
		auditor.Record(audit.Event{Action: "debug-open", Detail: req.Executable, Path: r.URL.Path})
	}
}

func (m *Manager) CommandHandler(auditor *audit.Auditor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req commandRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "decode body: "+err.Error(), http.StatusBadRequest)
			return
		}
		resp, err := m.Command(req)
		if err != nil {
			http.Error(w, "command session: "+err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
		auditor.Record(audit.Event{Action: "debug-command", Detail: req.ID, Path: r.URL.Path})
	}
}

func (m *Manager) CloseHandler(auditor *audit.Auditor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req closeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "decode body: "+err.Error(), http.StatusBadRequest)
			return
		}
		resp, err := m.Close(req.ID)
		if err != nil {
			http.Error(w, "close session: "+err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
		auditor.Record(audit.Event{Action: "debug-close", Detail: req.ID, Path: r.URL.Path})
	}
}

func (m *Manager) Open(ctx context.Context, req openRequest) (*Session, error) {
	if req.Executable == "" {
		return nil, errors.New("executable is required")
	}
	if len(req.Arguments) > 128 {
		return nil, errors.New("too many arguments")
	}
	if err := os.MkdirAll(m.baseDir, 0o700); err != nil {
		return nil, err
	}
	id := fmt.Sprintf("dbg-%d", time.Now().UnixNano())
	logPath := req.LogPath
	if logPath == "" {
		logPath = filepath.Join(m.baseDir, id+".log")
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, req.Executable, req.Arguments...)
	if req.WorkingDirectory != "" {
		cmd.Dir = req.WorkingDirectory
	}
	if len(req.Environment) > 0 {
		env := os.Environ()
		for k, v := range req.Environment {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = logFile.Close()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = logFile.Close()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = logFile.Close()
		return nil, err
	}
	session := &Session{id: id, cmd: cmd, stdin: stdin, logPath: logPath, started: time.Now(), done: make(chan error, 1)}
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return nil, err
	}
	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()
	go session.capture(stdout, logFile)
	go session.capture(stderr, logFile)
	go func() {
		session.done <- cmd.Wait()
		_ = logFile.Close()
	}()
	return session, nil
}

func (m *Manager) Command(req commandRequest) (commandResponse, error) {
	if req.ID == "" {
		return commandResponse{}, errors.New("id is required")
	}
	if len(req.Input) > maxCommandBytes {
		return commandResponse{}, errors.New("input exceeds maximum")
	}
	waitMs := req.WaitMs
	if waitMs <= 0 {
		waitMs = defaultCommandWaitMs
	}
	if waitMs > maxCommandWaitMs {
		return commandResponse{}, errors.New("waitMs exceeds maximum")
	}
	session, ok := m.get(req.ID)
	if !ok {
		return commandResponse{}, errors.New("session not found")
	}
	if _, err := io.WriteString(session.stdin, req.Input+"\r\n"); err != nil {
		return commandResponse{}, err
	}
	timer := time.NewTimer(time.Duration(waitMs) * time.Millisecond)
	defer timer.Stop()
	select {
	case err := <-session.done:
		m.remove(req.ID)
		out, truncated := session.drain()
		resp := commandResponse{ID: req.ID, OutputBase64: base64.StdEncoding.EncodeToString(out), Truncated: truncated, LogPath: session.logPath, Exited: true}
		if err != nil {
			resp.ExitError = err.Error()
		}
		return resp, nil
	case <-timer.C:
		out, truncated := session.drain()
		return commandResponse{ID: req.ID, OutputBase64: base64.StdEncoding.EncodeToString(out), Truncated: truncated, LogPath: session.logPath}, nil
	}
}

func (m *Manager) Close(id string) (closeResponse, error) {
	session, ok := m.get(id)
	if !ok {
		return closeResponse{}, errors.New("session not found")
	}
	_ = session.stdin.Close()
	if session.cmd.Process != nil {
		_ = session.cmd.Process.Kill()
	}
	m.remove(id)
	return closeResponse{ID: id, Closed: true, LogPath: session.logPath}, nil
}

func (m *Manager) get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	return s, ok
}

func (m *Manager) remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, id)
}

func (s *Session) capture(reader io.Reader, logFile *os.File) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		line := append(scanner.Bytes(), '\n')
		_, _ = logFile.Write(line)
		s.mu.Lock()
		if len(s.buffer) < maxResponseBytes {
			remaining := maxResponseBytes - len(s.buffer)
			if len(line) <= remaining {
				s.buffer = append(s.buffer, line...)
			} else {
				s.buffer = append(s.buffer, line[:remaining]...)
				s.truncated = true
			}
		} else {
			s.truncated = true
		}
		s.mu.Unlock()
	}
}

func (s *Session) drain() ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]byte(nil), s.buffer...)
	truncated := s.truncated
	s.buffer = nil
	s.truncated = false
	return out, truncated
}
