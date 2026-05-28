// Package files implements bounded /upload and /download endpoints. All paths
// must resolve inside the staging directory.
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/Adamkadaban/crucible/guest-agent/internal/audit"
)

type uploadResponse struct {
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	Sha256     string `json:"sha256"`
}

type downloadHeader struct {
	Path string `json:"path"`
}

// UploadHandler accepts a multipart-less binary upload via POST. The target
// path is derived from a `path` query parameter and must resolve inside the
// staging directory.
func UploadHandler(auditor *audit.Auditor, stagingDir string, maxBytes int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		target := r.URL.Query().Get("path")
		if target == "" {
			http.Error(w, "missing ?path", http.StatusBadRequest)
			return
		}
		clean, err := resolveStagingPath(stagingDir, target)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := os.MkdirAll(filepath.Dir(clean), 0o700); err != nil {
			http.Error(w, "create parent: "+err.Error(), http.StatusInternalServerError)
			return
		}
		f, err := os.OpenFile(clean, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			http.Error(w, "open target: "+err.Error(), http.StatusInternalServerError)
			return
		}
		hash := sha256.New()
		n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(r.Body, maxBytes))
		closeErr := f.Close()
		if err != nil {
			http.Error(w, "write: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if closeErr != nil {
			http.Error(w, "close: "+closeErr.Error(), http.StatusInternalServerError)
			return
		}
		body := uploadResponse{Path: clean, SizeBytes: n, Sha256: hex.EncodeToString(hash.Sum(nil))}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
		auditor.Record(audit.Event{
			Action: "upload",
			Detail: fmt.Sprintf("%s (%d bytes, sha256=%s)", clean, n, body.Sha256),
			Path:   r.URL.Path,
		})
	}
}

// DownloadHandler streams a file under the staging directory back to the
// caller.
func DownloadHandler(auditor *audit.Auditor, stagingDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		target := r.URL.Query().Get("path")
		if target == "" {
			http.Error(w, "missing ?path", http.StatusBadRequest)
			return
		}
		clean, err := resolveStagingPath(stagingDir, target)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f, err := os.Open(clean)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, "open: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			http.Error(w, "stat: "+err.Error(), http.StatusInternalServerError)
			return
		}
		hash := sha256.New()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Crucible-Size", fmt.Sprintf("%d", info.Size()))
		w.Header().Set("Trailer", "X-Crucible-Sha256")
		if _, err := io.Copy(io.MultiWriter(w, hash), f); err != nil {
			return
		}
		w.Header().Set("X-Crucible-Sha256", hex.EncodeToString(hash.Sum(nil)))
		auditor.Record(audit.Event{
			Action: "download",
			Detail: fmt.Sprintf("%s (%d bytes)", clean, info.Size()),
			Path:   r.URL.Path,
		})

		// expose hash header for non-trailer clients
		_ = downloadHeader{Path: clean}
	}
}

// resolveStagingPath joins target onto stagingDir, refusing anything that
// escapes (e.g. via ".." segments or absolute paths).
func resolveStagingPath(stagingDir, target string) (string, error) {
	// Reject absolute paths so the client must use staging-relative names.
	if filepath.IsAbs(target) {
		return "", errors.New("path must be relative to the staging directory")
	}
	clean := filepath.Clean(filepath.Join(stagingDir, target))
	relDir, err := filepath.Abs(stagingDir)
	if err != nil {
		return "", fmt.Errorf("resolve staging dir: %w", err)
	}
	absClean, err := filepath.Abs(clean)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	rel, err := filepath.Rel(relDir, absClean)
	if err != nil {
		return "", fmt.Errorf("relpath: %w", err)
	}
	if strings.HasPrefix(rel, "..") || rel == "." {
		return "", errors.New("path escapes staging directory")
	}
	return absClean, nil
}
