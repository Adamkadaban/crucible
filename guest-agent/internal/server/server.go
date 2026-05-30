// Package server wires the HTTPS handler, mTLS verification, audit logging,
// and graceful shutdown for the Crucible guest agent.
package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Adamkadaban/crucible/guest-agent/internal/audit"
	"github.com/Adamkadaban/crucible/guest-agent/internal/exec"
	"github.com/Adamkadaban/crucible/guest-agent/internal/files"
	"github.com/Adamkadaban/crucible/guest-agent/internal/health"
)

// Config controls the bound listener, TLS material, and bounded transfer sizes.
type Config struct {
	ListenAddress           string
	ServerCertificatePath   string
	ServerPrivateKeyPath    string
	ClientCACertificatePath string
	AuditLogPath            string
	StagingDirectory        string
	CredentialsPath         string
	ExecDirectory           string
	MaxRequestBytes         int64
	Version                 string
	// Internal hooks so tests can inject a listener (e.g., 127.0.0.1:0).
	Listener net.Listener
	// ListenerReady is closed once the TLS listener has bound successfully,
	// before srv.Serve starts accepting. Callers (e.g. the Windows service
	// handler) use this to wait for a real bind before reporting Running so
	// SCM never sees Running while the port is still unreachable.
	ListenerReady chan<- struct{}
}

const defaultMaxRequestBytes = 64 * 1024 * 1024

// Run starts the HTTPS server, blocks until the context is cancelled or the
// process receives SIGINT/SIGTERM, then performs a 5s graceful shutdown.
func Run(parent context.Context, cfg Config) error {
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = defaultMaxRequestBytes
	}
	if cfg.StagingDirectory == "" {
		return errors.New("staging directory is required")
	}
	if err := os.MkdirAll(cfg.StagingDirectory, 0o700); err != nil {
		return fmt.Errorf("create staging directory: %w", err)
	}

	auditor, closeAudit, err := audit.Open(cfg.AuditLogPath)
	if err != nil {
		return err
	}
	defer closeAudit()

	listener := cfg.Listener
	if listener == nil {
		listener, err = bindTLSListener(cfg)
		if err != nil {
			return err
		}
	}
	defer listener.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", health.Handler(cfg.Version))
	execRunner, err := exec.NewRunner(cfg.CredentialsPath, cfg.ExecDirectory)
	if err != nil {
		return err
	}
	mux.HandleFunc("/exec", exec.Handler(auditor, cfg.MaxRequestBytes, execRunner))
	mux.HandleFunc("/upload", files.UploadHandler(auditor, cfg.StagingDirectory))
	mux.HandleFunc("/download", files.DownloadHandler(auditor, cfg.StagingDirectory))
	mux.HandleFunc("/inspect", files.InspectHandler(auditor, cfg.StagingDirectory))

	srv := &http.Server{
		Handler:           withRequestID(withClientIdentity(auditor, mux)),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if cfg.ListenerReady != nil {
		close(cfg.ListenerReady)
	}

	ctx, cancel := signal.NotifyContext(parent, syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.Serve(listener)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		return nil
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func bindTLSListener(cfg Config) (net.Listener, error) {
	cert, err := tls.LoadX509KeyPair(cfg.ServerCertificatePath, cfg.ServerPrivateKeyPath)
	if err != nil {
		return nil, fmt.Errorf("load server keypair: %w", err)
	}
	pool := x509.NewCertPool()
	caBytes, err := os.ReadFile(filepath.Clean(cfg.ClientCACertificatePath))
	if err != nil {
		return nil, fmt.Errorf("read client CA: %w", err)
	}
	if !pool.AppendCertsFromPEM(caBytes) {
		return nil, errors.New("no certificates found in client CA bundle")
	}
	tlsCfg := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
	}
	// Use net.ListenConfig with Control to set SO_REUSEADDR. Re-provision
	// runs (and Windows TcpTimedWaitDelay TIME_WAIT after a previous
	// instance dies) otherwise leave the port unbindable for 30-240s,
	// surfacing as "Only one usage of each socket address" on the next
	// listen attempt. SO_REUSEADDR + SO_EXCLUSIVEADDRUSE off lets us
	// rebind a TIME_WAIT socket immediately. Note the Windows variant
	// of SO_REUSEADDR differs from Linux: it permits multiple sockets
	// to bind the same address concurrently. We accept that tradeoff
	// for the agent because the listener address (192.0.2.2 host-only)
	// is firewalled to the host's 192.0.2.1 source.
	lc := net.ListenConfig{Control: setReuseAddr}
	raw, err := lc.Listen(context.Background(), "tcp", cfg.ListenAddress)
	if err != nil {
		return nil, err
	}
	return tls.NewListener(raw, tlsCfg), nil
}

// writeJSON sends a structured response with the supplied status and body.
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// readAll bounded read used by JSON handlers (the bodies are small).
func readAll(r io.Reader, max int64) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r, max))
}
