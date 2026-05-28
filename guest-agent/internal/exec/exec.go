// Package exec implements POST /exec — bounded command execution as the
// agent's identity (LocalSystem on Windows, the running user elsewhere).
package exec

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/Adamkadaban/crucible/guest-agent/internal/audit"
)

const (
	maxArgs           = 64
	maxOutputBytes    = 4 * 1024 * 1024 // 4 MiB per stream
	defaultTimeoutMs  = 60_000
	maxTimeoutMs      = 30 * 60 * 1000
)

type request struct {
	Executable  string            `json:"executable"`
	Arguments   []string          `json:"arguments,omitempty"`
	WorkingDir  string            `json:"workingDirectory,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
	TimeoutMs   int               `json:"timeoutMs,omitempty"`
}

type response struct {
	ExitCode    int    `json:"exitCode"`
	StdoutBase64 string `json:"stdoutBase64,omitempty"`
	StderrBase64 string `json:"stderrBase64,omitempty"`
	TimedOut    bool   `json:"timedOut"`
	DurationMs  int64  `json:"durationMs"`
	Truncated   bool   `json:"truncated"`
}

// Handler returns the /exec http.HandlerFunc.
func Handler(auditor *audit.Auditor, maxRequestBytes int64) http.HandlerFunc {
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
		result, err := run(r.Context(), req)
		if err != nil {
			http.Error(w, "exec: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
		auditor.Record(audit.Event{
			Action: "exec",
			Detail: req.Executable,
			Path:   r.URL.Path,
		})
	}
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
	return nil
}

func run(ctx context.Context, req request) (response, error) {
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
	err := cmd.Run()
	duration := time.Since(start)
	if errors.Is(cmdCtx.Err(), context.DeadlineExceeded) {
		return response{TimedOut: true, DurationMs: duration.Milliseconds()}, nil
	}
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
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
