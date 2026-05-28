package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestRunHealthEndpointHandshake verifies mTLS works end-to-end and that
// /health responds with the agent identity.
func TestRunHealthEndpointHandshake(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	caCert, caKey := mustGenerateCA(t)
	clientCert, clientKey := mustIssue(t, "host-client", caCert, caKey)
	serverCert, serverKey := mustIssue(t, "localhost", caCert, caKey)

	caPath := writePEM(t, root, "ca.pem", "CERTIFICATE", caCert.Raw)
	serverCertPath := writePEM(t, root, "server.pem", "CERTIFICATE", serverCert.Raw)
	serverKeyPath := writePrivateKey(t, root, "server.key", serverKey)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	cfg := Config{
		ListenAddress:           listener.Addr().String(),
		ServerCertificatePath:   serverCertPath,
		ServerPrivateKeyPath:    serverKeyPath,
		ClientCACertificatePath: caPath,
		StagingDirectory:        filepath.Join(root, "staging"),
		MaxRequestBytes:         1024,
		Version:                 "test",
	}
	// Wrap the listener in TLS the same way the production path does so we
	// can drive the server from this test.
	tlsCert, err := tls.LoadX509KeyPair(serverCertPath, serverKeyPath)
	if err != nil {
		t.Fatalf("load keypair: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	cfg.Listener = tls.NewListener(listener, &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{tlsCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
	})

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ready := make(chan struct{})
	cfg.ListenerReady = ready
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, cfg)
	}()
	// ListenerReady must close before the test can connect, which proves
	// the signal fires after a successful bind. A bare goroutine + sleep
	// would race; this select fails fast if Run errors out.
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("Run returned before ListenerReady: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatalf("ListenerReady never closed")
	}

	clientTLSCert := tls.Certificate{
		Certificate: [][]byte{clientCert.Raw},
		PrivateKey:  clientKey,
	}
	rootPool := x509.NewCertPool()
	rootPool.AddCert(caCert)
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion:   tls.VersionTLS13,
				ServerName:   "localhost",
				Certificates: []tls.Certificate{clientTLSCert},
				RootCAs:      rootPool,
			},
		},
		Timeout: 5 * time.Second,
	}

	for i := 0; i < 50; i++ {
		if _, err := net.DialTimeout("tcp", cfg.ListenAddress, 100*time.Millisecond); err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	resp, err := client.Get("https://" + cfg.ListenAddress + "/health")
	if err != nil {
		t.Fatalf("health request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("decode body: %v (raw=%s)", err, string(body))
	}
	if parsed["status"] != "ok" {
		t.Fatalf("unexpected status: %v", parsed["status"])
	}
	if parsed["version"] != "test" {
		t.Fatalf("unexpected version: %v", parsed["version"])
	}
	if rid := resp.Header.Get("X-Request-Id"); rid == "" {
		t.Fatalf("missing request id header")
	}
	cancel()
	// Run() may return either nil (clean shutdown) or a Shutdown deadline
	// error when other in-flight handshakes hold the listener open. Either
	// is acceptable; what we want to guarantee is that Run() actually
	// returned and didn't leak the goroutine.
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("Run did not return after cancel")
	}
}

func mustGenerateCA(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ca key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "crucible-test-ca"},
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create ca: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse ca: %v", err)
	}
	return cert, key
}

func mustIssue(t *testing.T, cn string, ca *x509.Certificate, caKey *ecdsa.PrivateKey) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("issue key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:     []string{cn},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatalf("issue cert: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse issued cert: %v", err)
	}
	return cert, key
}

func writePEM(t *testing.T, dir, name, blockType string, der []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func writePrivateKey(t *testing.T, dir, name string, key *ecdsa.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	return writePEM(t, dir, name, "EC PRIVATE KEY", der)
}
