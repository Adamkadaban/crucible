//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/Adamkadaban/crucible/guest-agent/internal/server"
	"github.com/Adamkadaban/crucible/guest-agent/internal/service"
	"golang.org/x/sys/windows/svc"
)

// maybeRunAsService dispatches the Windows service handler synchronously
// when launched by SCM. Returns true after the dispatcher exits; the caller
// is expected to return without falling through to the cobra CLI. Returns
// false in console mode (interactive runs of `crucible-agent.exe run` /
// `install` / `uninstall` / `version`).
//
// Critically this is called from main() — calling svc.Run from init()
// prevents Go's runtime from starting the main goroutine, SCM never
// receives a registered handler, and the service hangs in START_PENDING.
func maybeRunAsService() bool {
	inService, err := svc.IsWindowsService()
	if err != nil || !inService {
		return false
	}
	if err := svc.Run(service.ServiceName, &serviceHandler{}); err != nil {
		fmt.Fprintln(os.Stderr, "svc.Run:", err)
		os.Exit(1)
	}
	return true
}

type serviceHandler struct{}

// Execute satisfies svc.Handler. We translate SCM control events into
// context cancellation so server.Run can perform its 5s graceful shutdown.
func (serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepts = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// SCM hands us the service-side argv (just the service name). Build
	// server.Config from the process's real argv instead — the ImagePath
	// registry value already includes the --listen / --tls-* flags.
	cfg, parseErr := parseServerArgsFromOsArgs(os.Args[2:])
	if parseErr != nil {
		fmt.Fprintln(os.Stderr, "config:", parseErr)
		return false, 1
	}

	done := make(chan error, 1)
	ready := make(chan struct{})
	cfg.ListenerReady = ready
	go func() {
		done <- server.Run(ctx, cfg)
	}()

	// Wait for either the listener to come up or server.Run to bail. This
	// replaces a fixed sleep that raced against slow VMs (Running before
	// the port was reachable) and fast errors (Running reported even
	// though server.Run had already failed).
	select {
	case <-ready:
		status <- svc.Status{State: svc.Running, Accepts: accepts}
	case err := <-done:
		if err != nil {
			fmt.Fprintln(os.Stderr, "server.Run:", err)
		}
		return false, 1
	}

	for {
		select {
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		case err := <-done:
			if err != nil {
				fmt.Fprintln(os.Stderr, "server.Run:", err)
				return false, 1
			}
			return false, 0
		}
	}
}

// parseServerArgsFromOsArgs builds a server.Config from the CLI args
// embedded in the service's ImagePath (everything after the leading
// `run` subcommand). Supports a small subset of the cobra flags —
// anything not recognised returns an error so misconfigured services
// fail loudly instead of silently ignoring options.
func parseServerArgsFromOsArgs(args []string) (server.Config, error) {
	cfg := server.Config{
		ListenAddress:    "127.0.0.1:8443",
		StagingDirectory: `C:\ProgramData\Crucible\staging`,
		ExecDirectory:    `C:\ProgramData\Crucible\Exec`,
		MaxRequestBytes:  64 * 1024 * 1024,
	}
	consume := func(i int, flag string) (string, error) {
		if i+1 >= len(args) {
			return "", fmt.Errorf("flag %s requires a value", flag)
		}
		return args[i+1], nil
	}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--listen", "--tls-cert", "--tls-key", "--tls-client-ca",
			"--audit-log", "--staging-dir", "--credentials", "--exec-dir", "--max-request-bytes":
			value, err := consume(i, args[i])
			if err != nil {
				return cfg, err
			}
			switch args[i] {
			case "--listen":
				cfg.ListenAddress = value
			case "--tls-cert":
				cfg.ServerCertificatePath = value
			case "--tls-key":
				cfg.ServerPrivateKeyPath = value
			case "--tls-client-ca":
				cfg.ClientCACertificatePath = value
			case "--audit-log":
				cfg.AuditLogPath = value
			case "--staging-dir":
				cfg.StagingDirectory = value
			case "--credentials":
				cfg.CredentialsPath = value
			case "--exec-dir":
				cfg.ExecDirectory = value
			case "--max-request-bytes":
				n, err := strconv.ParseInt(value, 10, 64)
				if err != nil {
					return cfg, fmt.Errorf("invalid --max-request-bytes %q: %w", value, err)
				}
				cfg.MaxRequestBytes = n
			}
			i++
		default:
			return cfg, fmt.Errorf("unknown service flag: %s", args[i])
		}
	}
	return cfg, nil
}
