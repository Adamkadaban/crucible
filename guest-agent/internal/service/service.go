// Package service wires the agent into the Windows Service Control Manager
// on Windows. On non-Windows platforms (e.g. host CI) it provides stubs that
// compile and clearly error out at runtime.
//
// Only the install/uninstall management commands are exposed from the CLI;
// the actual service body that calls server.Run is plumbed by the runtime
// dispatch in cmd/crucible-guest-agent on Windows builds.
package service

// InstallConfig is the options bag the CLI exposes through the `install`
// subcommand.
type InstallConfig struct {
	DisplayName string
	Description string
	Arguments   []string
}
