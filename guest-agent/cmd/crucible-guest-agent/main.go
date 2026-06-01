// crucible-guest-agent is the Windows-side control plane that the host MCP
// server reaches over the host-only network. It exposes an mTLS-authenticated
// HTTP API for health checks, command execution, and file transfer.
package main

import (
	"fmt"
	"os"

	"github.com/Adamkadaban/crucible/guest-agent/internal/server"
	"github.com/Adamkadaban/crucible/guest-agent/internal/service"
	"github.com/spf13/cobra"
)

func main() {
	// Service-mode dispatch happens here in main(), not in init() — calling
	// svc.Run from init() prevents Go's runtime from starting the main
	// goroutine and SCM never receives a registered handler. The Windows
	// build supplies maybeRunAsService; on non-Windows builds it's a no-op
	// that returns false.
	if maybeRunAsService() {
		return
	}

	root := &cobra.Command{
		Use:   "crucible-guest-agent",
		Short: "Crucible Windows guest control service",
	}
	root.AddCommand(newRunCommand())
	root.AddCommand(newInstallCommand())
	root.AddCommand(newUninstallCommand())
	root.AddCommand(newVersionCommand())
	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

const defaultListenAddress = "127.0.0.1:8443"

func newRunCommand() *cobra.Command {
	var cfg server.Config
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run the guest agent in the foreground",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg.Version = version
			return server.Run(cmd.Context(), cfg)
		},
	}
	cmd.Flags().StringVar(&cfg.ListenAddress, "listen", defaultListenAddress,
		"TCP address to listen on (host-only network)")
	cmd.Flags().StringVar(&cfg.ServerCertificatePath, "tls-cert", "",
		"Path to the guest server certificate (PEM)")
	cmd.Flags().StringVar(&cfg.ServerPrivateKeyPath, "tls-key", "",
		"Path to the guest server private key (PEM)")
	cmd.Flags().StringVar(&cfg.ClientCACertificatePath, "tls-client-ca", "",
		"Path to the host CA certificate used to authenticate clients (PEM)")
	cmd.Flags().StringVar(&cfg.AuditLogPath, "audit-log", "",
		"Path to the JSONL audit log; if empty, audit events are written to stderr")
	cmd.Flags().Int64Var(&cfg.MaxRequestBytes, "max-request-bytes", 64*1024*1024,
		"Maximum allowed HTTP request body size in bytes")
	cmd.Flags().StringVar(&cfg.StagingDirectory, "staging-dir",
		"C:\\\\ProgramData\\\\Crucible\\\\staging",
		"Directory uploads must land in and downloads must come from")
	cmd.Flags().StringVar(&cfg.CredentialsPath, "credentials", "",
		"Path to execution account credentials JSON")
	cmd.Flags().StringVar(&cfg.ExecDirectory, "exec-dir", "C:\\ProgramData\\Crucible\\Exec",
		"Directory used for cross-account execution shims")
	return cmd
}

func newInstallCommand() *cobra.Command {
	var cfg service.InstallConfig
	cmd := &cobra.Command{
		Use:   "install",
		Short: "Install the agent as a Windows service",
		RunE: func(_ *cobra.Command, _ []string) error {
			return service.Install(cfg)
		},
	}
	cmd.Flags().StringVar(&cfg.DisplayName, "display-name", "Crucible Guest Agent",
		"Windows service display name")
	cmd.Flags().StringVar(&cfg.Description, "description",
		"Crucible Windows guest control service",
		"Windows service description")
	cmd.Flags().StringSliceVar(&cfg.Arguments, "args", nil,
		"Extra arguments appended to the `run` command at service start")
	return cmd
}

func newUninstallCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall the Windows service",
		RunE: func(_ *cobra.Command, _ []string) error {
			return service.Uninstall()
		},
	}
}

// Version is overwritten at build time via -ldflags "-X main.version=<sha>"
var version = "dev"

func newVersionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the agent version",
		Run: func(_ *cobra.Command, _ []string) {
			fmt.Println(version)
		},
	}
}
