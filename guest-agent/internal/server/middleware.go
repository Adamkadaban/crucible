package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"

	"github.com/Adamkadaban/crucible/guest-agent/internal/audit"
)

type contextKey string

const (
	contextKeyRequestID  contextKey = "request-id"
	contextKeyClientName contextKey = "client-name"
)

func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set("X-Request-Id", id)
		ctx := context.WithValue(r.Context(), contextKeyRequestID, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func newRequestID() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}

// RequestID returns the request id associated with the inbound context, or an
// empty string if one was never assigned (e.g. from non-handler code paths).
func RequestID(ctx context.Context) string {
	if id, ok := ctx.Value(contextKeyRequestID).(string); ok {
		return id
	}
	return ""
}

// ClientName returns the client certificate CommonName for the request, or
// the literal string "unauthenticated" when one was not negotiated.
func ClientName(ctx context.Context) string {
	if name, ok := ctx.Value(contextKeyClientName).(string); ok && name != "" {
		return name
	}
	return "unauthenticated"
}

// withClientIdentity records the verified peer CommonName on the request
// context and audits every accepted request before forwarding to the route
// handlers. mTLS verification has already happened in the TLS listener.
func withClientIdentity(auditor *audit.Auditor, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		client := ""
		if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
			client = r.TLS.PeerCertificates[0].Subject.CommonName
		}
		ctx := context.WithValue(r.Context(), contextKeyClientName, client)
		next.ServeHTTP(w, r.WithContext(ctx))
		auditor.Record(audit.Event{
			RequestID: RequestID(ctx),
			Client:    client,
			Method:    r.Method,
			Path:      r.URL.Path,
		})
	})
}
