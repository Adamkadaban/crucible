// Package exec implements POST /exec — bounded command execution as the
// agent's identity (LocalSystem on Windows, the running user elsewhere).
package exec

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/Adamkadaban/crucible/guest-agent/internal/audit"
)

const (
	maxArgs          = 64
	maxOutputBytes   = 4 * 1024 * 1024 // 4 MiB per stream
	defaultTimeoutMs = 60_000
	maxTimeoutMs     = 30 * 60 * 1000
)

type request struct {
	Executable  string            `json:"executable"`
	Arguments   []string          `json:"arguments,omitempty"`
	WorkingDir  string            `json:"workingDirectory,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
	TimeoutMs   int               `json:"timeoutMs,omitempty"`
	As          string            `json:"as,omitempty"`
}

type response struct {
	ExitCode     int    `json:"exitCode"`
	StdoutBase64 string `json:"stdoutBase64,omitempty"`
	StderrBase64 string `json:"stderrBase64,omitempty"`
	TimedOut     bool   `json:"timedOut"`
	DurationMs   int64  `json:"durationMs"`
	Truncated    bool   `json:"truncated"`
}

type accountCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type credentialsFile struct {
	Standard accountCredential `json:"standard"`
	Admin    accountCredential `json:"admin"`
}

type Runner struct {
	credentials credentialsFile
	hasCreds    bool
	execDir     string
}

func NewRunner(credentialsPath string, execDir string) (*Runner, error) {
	if credentialsPath == "" {
		return &Runner{execDir: execDir}, nil
	}
	data, err := os.ReadFile(credentialsPath)
	if err != nil {
		return nil, fmt.Errorf("read credentials: %w", err)
	}
	var creds credentialsFile
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("decode credentials: %w", err)
	}
	return &Runner{credentials: creds, hasCreds: true, execDir: execDir}, nil
}

// Handler returns the /exec http.HandlerFunc.
func Handler(auditor *audit.Auditor, maxRequestBytes int64, runner *Runner) http.HandlerFunc {
	if runner == nil {
		runner = &Runner{}
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
		if err != nil {
			var max *http.MaxBytesError
			if errors.As(err, &max) {
				http.Error(w, "payload exceeds max-request-bytes", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
			return
		}
		var req request
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, "decode body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := validate(req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		result, err := runner.run(r.Context(), req)
		if err != nil {
			http.Error(w, "exec: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
		auditor.Record(audit.Event{
			Action: "exec",
			Detail: executionDetail(req),
			Path:   r.URL.Path,
		})
	}
}

func executionDetail(req request) string {
	principal := req.As
	if principal == "" {
		principal = "service"
	}
	return principal + ":" + req.Executable
}

func validate(req request) error {
	if req.Executable == "" {
		return errors.New("executable is required")
	}
	if len(req.Arguments) > maxArgs {
		return errors.New("too many arguments")
	}
	if req.TimeoutMs > maxTimeoutMs {
		return errors.New("timeoutMs exceeds maximum")
	}
	if req.As != "" && req.As != "service" && req.As != "standard" && req.As != "admin" {
		return errors.New("as must be service, standard, or admin")
	}
	return nil
}

func (r *Runner) run(ctx context.Context, req request) (response, error) {
	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultTimeoutMs
	}
	cmdCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(cmdCtx, req.Executable, req.Arguments...)
	if req.WorkingDir != "" {
		cmd.Dir = req.WorkingDir
	}
	// Start from the inherited Windows environment so PATH/SystemRoot/etc.
	// survive, then layer in caller-supplied overrides. Always replacing the
	// env (the previous behaviour) broke loaders that depended on PATH.
	if len(req.Environment) > 0 {
		env := os.Environ()
		for k, v := range req.Environment {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
	}
	bufOut := newBoundedBuffer(maxOutputBytes)
	bufErr := newBoundedBuffer(maxOutputBytes)
	cmd.Stdout = bufOut
	cmd.Stderr = bufErr
	start := time.Now()
	err := r.runCommand(cmdCtx, req, cmd)
	duration := time.Since(start)
	if errors.Is(cmdCtx.Err(), context.DeadlineExceeded) {
		return response{TimedOut: true, DurationMs: duration.Milliseconds()}, nil
	}
	exitCode := 0
	if err != nil {
		var exitErr interface{ ExitCode() int }
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			return response{}, err
		}
	}
	return response{
		ExitCode:     exitCode,
		StdoutBase64: bufOut.encoded(),
		StderrBase64: bufErr.encoded(),
		DurationMs:   duration.Milliseconds(),
		Truncated:    bufOut.truncated || bufErr.truncated,
	}, nil
}
