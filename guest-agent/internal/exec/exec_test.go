package exec

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/Adamkadaban/crucible/guest-agent/internal/audit"
)

func TestExecRunsSimpleCommand(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("non-windows convenience test")
	}
	srv := httptest.NewServer(Handler(audit.New(io.Discard), 64*1024, nil))
	defer srv.Close()
	body, _ := json.Marshal(map[string]any{
		"executable": "/bin/sh",
		"arguments":  []string{"-c", "printf hello; printf world 1>&2"},
		"timeoutMs":  5_000,
	})
	resp, err := http.Post(srv.URL, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		buf, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(buf))
	}
	var out response
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.ExitCode != 0 {
		t.Fatalf("unexpected exit: %d", out.ExitCode)
	}
	stdout, _ := base64.StdEncoding.DecodeString(out.StdoutBase64)
	if string(stdout) != "hello" {
		t.Fatalf("unexpected stdout: %q", string(stdout))
	}
	stderr, _ := base64.StdEncoding.DecodeString(out.StderrBase64)
	if string(stderr) != "world" {
		t.Fatalf("unexpected stderr: %q", string(stderr))
	}
}

func TestExecRejectsExcessiveTimeout(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(Handler(audit.New(io.Discard), 64*1024, nil))
	defer srv.Close()
	body, _ := json.Marshal(map[string]any{
		"executable": "/bin/true",
		"timeoutMs":  maxTimeoutMs + 1,
	})
	resp, err := http.Post(srv.URL, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestExecRejectsUnsupportedPrincipalOnNonWindows(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("non-windows validation path")
	}
	srv := httptest.NewServer(Handler(audit.New(io.Discard), 64*1024, nil))
	defer srv.Close()
	body, _ := json.Marshal(map[string]any{
		"executable": "/bin/true",
		"as":         "admin",
	})
	resp, err := http.Post(srv.URL, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}
}

func TestRunTimeoutSurfaces(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("non-windows convenience test")
	}
	req := request{
		Executable: "/bin/sh",
		Arguments:  []string{"-c", "sleep 5"},
		TimeoutMs:  50,
	}
	res, err := (&Runner{}).run(context.Background(), req)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !res.TimedOut {
		t.Fatalf("expected timedOut=true, got %#v", res)
	}
}

func TestBoundedBufferTruncates(t *testing.T) {
	b := newBoundedBuffer(4)
	_, _ = b.Write([]byte("hello"))
	if !b.truncated {
		t.Fatalf("expected truncated=true")
	}
	if !strings.HasPrefix(string(b.buf), "hell") {
		t.Fatalf("expected leading content preserved, got %q", string(b.buf))
	}
}
