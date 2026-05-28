//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"

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
	go func() {
		done <- server.Run(ctx, cfg)
	}()

	// Give server.Run a moment to bind the listener before we report
	// Running so the operator sees a meaningful error if the bind fails.
	time.Sleep(200 * time.Millisecond)

	status <- svc.Status{State: svc.Running, Accepts: accepts}

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
		MaxRequestBytes:  64 * 1024 * 1024,
	}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--listen":
			i++
			cfg.ListenAddress = args[i]
		case "--tls-cert":
			i++
			cfg.ServerCertificatePath = args[i]
		case "--tls-key":
			i++
			cfg.ServerPrivateKeyPath = args[i]
		case "--tls-client-ca":
			i++
			cfg.ClientCACertificatePath = args[i]
		case "--audit-log":
			i++
			cfg.AuditLogPath = args[i]
		case "--staging-dir":
			i++
			cfg.StagingDirectory = args[i]
		case "--max-request-bytes":
			i++
			n, err := strconv.ParseInt(args[i], 10, 64)
			if err != nil {
				return cfg, fmt.Errorf("invalid --max-request-bytes %q: %w", args[i], err)
			}
			cfg.MaxRequestBytes = n
		default:
			return cfg, fmt.Errorf("unknown service flag: %s", args[i])
		}
	}
	return cfg, nil
}
