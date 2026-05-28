// Package health implements GET /health.
package health

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

var startedAt = time.Now()

type response struct {
	Status            string    `json:"status"`
	Version           string    `json:"version"`
	HostName          string    `json:"hostName"`
	StartedAt         time.Time `json:"startedAt"`
	UptimeSeconds     int64     `json:"uptimeSeconds"`
	GoVersion         string    `json:"goVersion"`
	WindbgInstalled   bool      `json:"windbgInstalled"`
	CdbPath           string    `json:"cdbPath,omitempty"`
	WindbgPath        string    `json:"windbgPath,omitempty"`
}

// Handler returns the /health http.HandlerFunc.
func Handler(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hostname, _ := os.Hostname()
		cdb := lookupDebugger("cdb.exe")
		windbg := lookupDebugger("windbg.exe")
		body := response{
			Status:          "ok",
			Version:         version,
			HostName:        hostname,
			StartedAt:       startedAt,
			UptimeSeconds:   int64(time.Since(startedAt).Seconds()),
			GoVersion:       runtime.Version(),
			WindbgInstalled: windbg != "" && cdb != "",
			CdbPath:         cdb,
			WindbgPath:      windbg,
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}
}

// lookupDebugger searches common Windows SDK locations for cdb.exe/windbg.exe.
// Returns the absolute path or empty string when not found.
func lookupDebugger(name string) string {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Windows Kits", "10", "Debuggers", "x64", name),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Windows Kits", "10", "Debuggers", "x64", name),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "WindowsApps", name),
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	return ""
}
