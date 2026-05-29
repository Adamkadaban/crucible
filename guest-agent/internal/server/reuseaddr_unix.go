//go:build !windows

package server

import "syscall"

// Non-Windows builds (the host-side tests + Linux dev cross-compile
// surface) just no-op. The Windows-only TIME_WAIT collision pattern
// doesn't apply to the test harness which uses ephemeral ports.
func setReuseAddr(_, _ string, _ syscall.RawConn) error {
	return nil
}
