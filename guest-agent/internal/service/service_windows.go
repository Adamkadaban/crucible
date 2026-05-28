//go:build windows

package service

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/svc/mgr"
)

// ServiceName is the Windows service identifier; matches what
// guest/provision/install-agent.ps1 expects.
const ServiceName = "CrucibleGuestAgent"

// Install registers the agent at its current executable path with the
// supplied display name + description. Existing services with the same name
// are returned as an error so the caller can choose to uninstall first.
func Install(cfg InstallConfig) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve current executable: %w", err)
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return fmt.Errorf("absolute current executable: %w", err)
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()
	if existing, err := m.OpenService(ServiceName); err == nil {
		_ = existing.Close()
		return fmt.Errorf("service %s already installed", ServiceName)
	}
	displayName := cfg.DisplayName
	if displayName == "" {
		displayName = "Crucible Guest Agent"
	}
	args := append([]string{"run"}, cfg.Arguments...)
	s, err := m.CreateService(ServiceName, exe, mgr.Config{
		DisplayName: displayName,
		Description: cfg.Description,
		StartType:   mgr.StartAutomatic,
	}, args...)
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()
	return nil
}

// Uninstall removes the agent from the Windows Service Control Manager.
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(ServiceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()
	return s.Delete()
}
