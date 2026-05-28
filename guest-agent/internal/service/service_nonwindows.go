//go:build !windows

package service

import "errors"

// ServiceName is consumed by the Windows-only build path.
const ServiceName = "CrucibleGuestAgent"

// Install registers the agent as a Windows service. Stubbed on non-Windows
// hosts so the CLI still compiles cross-platform.
func Install(_ InstallConfig) error {
	return errors.New("install is only supported on Windows builds")
}

// Uninstall removes the agent from the Windows Service Control Manager.
// Stubbed on non-Windows hosts.
func Uninstall() error {
	return errors.New("uninstall is only supported on Windows builds")
}
