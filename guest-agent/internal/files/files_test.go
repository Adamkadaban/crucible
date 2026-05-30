package files

import (
	"bytes"
	"compress/gzip"
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

func TestUploadDownloadAndInspectRoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	auditor := audit.New(io.Discard)
	mux := http.NewServeMux()
	mux.HandleFunc("/upload", UploadHandler(auditor, dir))
	mux.HandleFunc("/download", DownloadHandler(auditor, dir))
	mux.HandleFunc("/inspect", InspectHandler(auditor, dir))

	srv := httptest.NewServer(mux)
	defer srv.Close()

	payload := []byte("hello crucible")
	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	if _, err := zw.Write(payload); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/upload?path=samples/hello.bin", &compressed)
	req.Header.Set("Content-Encoding", "gzip")
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

	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	downloadResp, err := client.Get(srv.URL + "/download?path=samples/hello.bin")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if downloadResp.StatusCode != http.StatusOK {
		t.Fatalf("download status=%d", downloadResp.StatusCode)
	}
	zr, err := gzip.NewReader(downloadResp.Body)
	if err != nil {
		t.Fatalf("download gzip: %v", err)
	}
	body, _ := io.ReadAll(zr)
	_ = zr.Close()
	if !bytes.Equal(body, payload) {
		t.Fatalf("download mismatch")
	}

	inspectResp, err := http.Get(srv.URL + "/inspect?path=samples/hello.bin")
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if inspectResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(inspectResp.Body)
		t.Fatalf("inspect status=%d body=%s", inspectResp.StatusCode, string(body))
	}
	var inspect map[string]any
	if err := json.NewDecoder(inspectResp.Body).Decode(&inspect); err != nil {
		t.Fatalf("inspect decode: %v", err)
	}
	if inspect["headerAscii"] != "hello crucible" {
		t.Fatalf("header ascii: %v", inspect["headerAscii"])
	}
}

func TestUploadAcceptsAbsolutePathAndRejectsEscapedRelativePath(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	target := filepath.Join(dir, "absolute.bin")
	auditor := audit.New(io.Discard)
	srv := httptest.NewServer(UploadHandler(auditor, dir))
	defer srv.Close()

	resp, err := postGzip(srv.URL+"?path="+target, []byte("absolute"))
	if err != nil {
		t.Fatalf("absolute request: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("absolute status=%d body=%s", resp.StatusCode, string(body))
	}

	for _, target := range []string{"../escape", "sub/../../escape"} {
		resp, err := postGzip(srv.URL+"?path="+target, []byte("x"))
		if err != nil {
			t.Fatalf("%s: request: %v", target, err)
		}
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", target, resp.StatusCode)
		}
	}
}

func postGzip(url string, payload []byte) (*http.Response, error) {
	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	_, _ = zw.Write(payload)
	_ = zw.Close()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(compressed.String()))
	req.Header.Set("Content-Encoding", "gzip")
	return http.DefaultClient.Do(req)
}
