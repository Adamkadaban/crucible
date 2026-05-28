//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestParseServerArgsFromOsArgs_ValueRequired(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"listen alone", []string{"--listen"}, "flag --listen requires a value"},
		{"tls-cert alone", []string{"--tls-cert"}, "flag --tls-cert requires a value"},
		{"max-bytes alone", []string{"--max-request-bytes"}, "flag --max-request-bytes requires a value"},
		{"unknown flag", []string{"--bogus"}, "unknown service flag: --bogus"},
		{"bad number", []string{"--max-request-bytes", "abc"}, "invalid --max-request-bytes"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseServerArgsFromOsArgs(tc.args)
			if err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err.Error(), tc.want)
			}
		})
	}
}

func TestParseServerArgsFromOsArgs_RoundTrip(t *testing.T) {
	t.Parallel()
	cfg, err := parseServerArgsFromOsArgs([]string{
		"--listen", "192.0.2.2:8443",
		"--tls-cert", "C:\\cert.pem",
		"--tls-key", "C:\\key.pem",
		"--tls-client-ca", "C:\\ca.pem",
		"--staging-dir", "C:\\stage",
		"--audit-log", "C:\\audit.jsonl",
		"--max-request-bytes", "1048576",
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.ListenAddress != "192.0.2.2:8443" {
		t.Fatalf("listen: %q", cfg.ListenAddress)
	}
	if cfg.MaxRequestBytes != 1048576 {
		t.Fatalf("max-bytes: %d", cfg.MaxRequestBytes)
	}
}
