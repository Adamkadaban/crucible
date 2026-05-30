// Package files implements streaming compressed file-transfer endpoints.
package files

import (
	"compress/gzip"
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

const inspectHeaderBytes = 64

type transferResponse struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	Sha256    string `json:"sha256"`
}

type inspectResponse struct {
	Path        string `json:"path"`
	SizeBytes   int64  `json:"sizeBytes"`
	HeaderHex   string `json:"headerHex"`
	HeaderASCII string `json:"headerAscii"`
}

// UploadHandler accepts a gzip-compressed stream via POST and writes it to the
// requested guest path. Relative paths are resolved under stagingDir; absolute
// guest paths are used directly.
func UploadHandler(auditor *audit.Auditor, stagingDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		clean, err := resolveGuestPath(stagingDir, r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if r.Header.Get("Content-Encoding") != "gzip" {
			http.Error(w, "Content-Encoding must be gzip", http.StatusUnsupportedMediaType)
			return
		}
		reader, err := gzip.NewReader(r.Body)
		if err != nil {
			http.Error(w, "open gzip stream: "+err.Error(), http.StatusBadRequest)
			return
		}
		defer reader.Close()
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
		n, err := io.Copy(io.MultiWriter(f, hash), reader)
		closeErr := f.Close()
		if err != nil {
			_ = os.Remove(clean)
			http.Error(w, "write: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if closeErr != nil {
			http.Error(w, "close: "+closeErr.Error(), http.StatusInternalServerError)
			return
		}
		resp := transferResponse{Path: clean, SizeBytes: n, Sha256: hex.EncodeToString(hash.Sum(nil))}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
		auditor.Record(audit.Event{
			Action: "upload",
			Detail: fmt.Sprintf("%s (%d bytes, sha256=%s)", clean, n, resp.Sha256),
			Path:   r.URL.Path,
		})
	}
}

// DownloadHandler streams the requested guest file back with gzip transfer
// encoding. Relative paths are resolved under stagingDir; absolute guest paths
// are used directly.
func DownloadHandler(auditor *audit.Auditor, stagingDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		clean, err := resolveGuestPath(stagingDir, r.URL.Query().Get("path"))
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
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("X-Crucible-Size", fmt.Sprintf("%d", info.Size()))
		w.Header().Set("Trailer", "X-Crucible-Sha256")
		writer := gzip.NewWriter(w)
		_, copyErr := io.Copy(writer, io.TeeReader(f, hash))
		closeErr := writer.Close()
		if copyErr != nil || closeErr != nil {
			return
		}
		w.Header().Set("X-Crucible-Sha256", hex.EncodeToString(hash.Sum(nil)))
		auditor.Record(audit.Event{
			Action: "download",
			Detail: fmt.Sprintf("%s (%d bytes)", clean, info.Size()),
			Path:   r.URL.Path,
		})
	}
}

// InspectHandler returns size and a small header preview without streaming the
// whole file to the host.
func InspectHandler(auditor *audit.Auditor, stagingDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		clean, err := resolveGuestPath(stagingDir, r.URL.Query().Get("path"))
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
		header := make([]byte, inspectHeaderBytes)
		n, err := f.Read(header)
		if err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, "read header: "+err.Error(), http.StatusInternalServerError)
			return
		}
		resp := inspectResponse{
			Path:        clean,
			SizeBytes:   info.Size(),
			HeaderHex:   hex.EncodeToString(header[:n]),
			HeaderASCII: printableASCII(header[:n]),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
		auditor.Record(audit.Event{Action: "inspect", Detail: clean, Path: r.URL.Path})
	}
}

func resolveGuestPath(stagingDir, target string) (string, error) {
	if target == "" {
		return "", errors.New("missing ?path")
	}
	if filepath.IsAbs(target) || looksWindowsAbs(target) {
		return filepath.Clean(target), nil
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
	switch {
	case rel == ".":
		return "", errors.New("path must reference a file, not the staging directory itself")
	case rel == "..":
		return "", errors.New("path escapes staging directory")
	case strings.HasPrefix(rel, ".."+string(filepath.Separator)):
		return "", errors.New("path escapes staging directory")
	}
	return absClean, nil
}

func looksWindowsAbs(path string) bool {
	return len(path) >= 3 && path[1] == ':' && (path[2] == '\\' || path[2] == '/')
}

func printableASCII(buffer []byte) string {
	var b strings.Builder
	for _, byt := range buffer {
		if byt >= 0x20 && byt <= 0x7e {
			b.WriteByte(byt)
		} else {
			b.WriteByte('.')
		}
	}
	return b.String()
}
