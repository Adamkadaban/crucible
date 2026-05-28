//go:build windows

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/Adamkadaban/crucible/guest-agent/internal/server"
	"github.com/Adamkadaban/crucible/guest-agent/internal/service"
	"github.com/spf13/cobra"
	"golang.org/x/sys/windows/svc"
)

// init detects whether the binary was started by the Windows Service Control
// Manager and, if so, dispatches the service handler before cobra has a chance
// to print any usage. When run from the console we fall through to the cobra
// CLI defined in main.go.
func init() {
	if len(os.Args) >= 2 && os.Args[1] == "run" {
		// allow `run` to be executed manually OR via SCM — detect SCM by
		// asking the runtime whether we're a service.
		inService, err := svc.IsWindowsService()
		if err == nil && inService {
			go func() {
				if err := svc.Run(service.ServiceName, &serviceHandler{}); err != nil {
					fmt.Fprintln(os.Stderr, "svc.Run:", err)
					os.Exit(1)
				}
			}()
		}
	}
}

type serviceHandler struct{}

// Execute satisfies svc.Handler. We translate SCM control events into
// context cancellation so server.Run can perform its 5s graceful shutdown.
func (serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepts = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		// Re-use the cobra-parsed configuration by invoking the run command
		// in-process. cobra exposes the same Config via newRunCommand().
		runCmd := newRunCommand()
		runCmd.SetArgs(os.Args[2:])
		runCmd.SetContext(ctx)
		done <- runCmd.Execute()
	}()
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
				return false, 1
			}
			return false, 0
		}
	}
}

// Unused but satisfies the compiler when the file is imported on Windows
// without main.go being aware of it. The init above hands off to cobra.
var _ = cobra.Command{}
var _ = server.Config{}
