//go:build windows

package server

import (
	"syscall"

	"golang.org/x/sys/windows"
)

// setReuseAddr is a net.ListenConfig.Control callback that flips
// SO_REUSEADDR on the listener socket. Pairs with the comment in
// bindTLSListener: lets a freshly-started service grab a port that
// the previous instance left in TIME_WAIT. The matching POSIX
// implementation lives in reuseaddr_unix.go.
func setReuseAddr(_, _ string, c syscall.RawConn) error {
	var sysErr error
	if err := c.Control(func(fd uintptr) {
		sysErr = windows.SetsockoptInt(windows.Handle(fd), windows.SOL_SOCKET, windows.SO_REUSEADDR, 1)
	}); err != nil {
		return err
	}
	return sysErr
}
