// Package audit appends JSON-line audit events to a log file or stderr.
package audit

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// Event is one row in the audit log.
type Event struct {
	Time      time.Time `json:"time"`
	RequestID string    `json:"requestId,omitempty"`
	Client    string    `json:"client,omitempty"`
	Method    string    `json:"method,omitempty"`
	Path      string    `json:"path,omitempty"`
	Action    string    `json:"action,omitempty"`
	Detail    string    `json:"detail,omitempty"`
}

// Auditor serialises Record() calls onto the underlying writer.
type Auditor struct {
	mu  sync.Mutex
	w   io.Writer
	enc *json.Encoder
}

// Open returns an auditor that writes to the supplied JSONL file (created
// 0o600), or to stderr if path is empty. The returned close func flushes and
// closes the file when applicable.
func Open(path string) (*Auditor, func(), error) {
	if path == "" {
		return New(os.Stderr), func() {}, nil
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, func() {}, fmt.Errorf("open audit log %s: %w", path, err)
	}
	return New(f), func() { _ = f.Close() }, nil
}

// New wraps the supplied writer in an Auditor.
func New(w io.Writer) *Auditor {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return &Auditor{w: w, enc: enc}
}

// Record stamps and writes a single event.
func (a *Auditor) Record(event Event) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if event.Time.IsZero() {
		event.Time = time.Now().UTC()
	}
	_ = a.enc.Encode(event)
}
