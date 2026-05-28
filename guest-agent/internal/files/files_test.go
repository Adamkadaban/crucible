package files

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Adamkadaban/crucible/guest-agent/internal/audit"
)

func TestUploadAndDownloadRoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	auditor := audit.New(io.Discard)
	mux := http.NewServeMux()
	mux.HandleFunc("/upload", UploadHandler(auditor, dir, 1024))
	mux.HandleFunc("/download", DownloadHandler(auditor, dir))

	srv := httptest.NewServer(mux)
	defer srv.Close()

	payload := []byte("hello crucible")
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/upload?path=samples/hello.bin", bytes.NewReader(payload))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("upload status=%d body=%s", resp.StatusCode, string(body))
	}
	var meta map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&meta)
	if meta["sizeBytes"].(float64) != float64(len(payload)) {
		t.Fatalf("size mismatch: %v", meta["sizeBytes"])
	}
	got, err := os.ReadFile(filepath.Join(dir, "samples", "hello.bin"))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload mismatch")
	}

	downloadResp, err := http.Get(srv.URL + "/download?path=samples/hello.bin")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if downloadResp.StatusCode != http.StatusOK {
		t.Fatalf("download status=%d", downloadResp.StatusCode)
	}
	body, _ := io.ReadAll(downloadResp.Body)
	if !bytes.Equal(body, payload) {
		t.Fatalf("download mismatch")
	}
}

func TestUploadRejectsPathEscape(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	auditor := audit.New(io.Discard)
	srv := httptest.NewServer(UploadHandler(auditor, dir, 1024))
	defer srv.Close()

	for _, target := range []string{
		"../escape",
		"/absolute/path",
		"sub/../../escape",
	} {
		resp, err := http.Post(srv.URL+"?path="+target, "application/octet-stream", strings.NewReader("x"))
		if err != nil {
			t.Fatalf("%s: request: %v", target, err)
		}
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", target, resp.StatusCode)
		}
	}
}
