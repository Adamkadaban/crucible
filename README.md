<h1 align="center">crucible</h1>

<p align="center">
  Build, snapshot, and control isolated Windows analysis VMs from Linux MCP agents.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.12.0-339933">
  <img alt="Platform" src="https://img.shields.io/badge/platform-linux%20%2B%20kvm-informational">
  <img alt="made with vibes" src="https://img.shields.io/badge/made_with-vibes-ff69b4">
</p>

Crucible provisions a Windows analysis VM on QEMU/KVM, installs debugger tooling and a small mTLS
guest agent, then exposes VM control through a CLI and MCP server.

Use it for local malware-analysis and Windows debugging workflows where you control the host. Do not
treat it as a hard containment boundary against VM escapes or host-kernel bugs.

## Quick Start

Requirements:

- Linux host with KVM access.
- QEMU, OVMF, `swtpm`, `socat`, and `xorriso`.
- Local Windows installer ISO, virtio-win ISO, and virtio guest tools installer.

Debian / Ubuntu baseline:

```sh
sudo apt install qemu-system-x86 qemu-utils ovmf swtpm socat xorriso
```

Install the CLI:

```sh
npm install -g @adamkadaban/crucible
crucible doctor
```

Create a config, edit the media paths, and provision:

```sh
crucible config init
crucible provision
crucible guest health
crucible snapshot list
```

The first provision usually takes 12-18 minutes and creates a `clean-base` snapshot. Restore that
snapshot before each new analysis session.

## MCP Server

Run the MCP server over stdio:

```sh
crucible mcp --stdio
```

Use the setup helpers instead of hand-editing client config:

```sh
crucible setup opencode
crucible setup claude
crucible setup codex --print
crucible setup copilot --print
```

Example opencode config:

```json
{
  "mcp": {
    "crucible": {
      "enabled": true,
      "type": "local",
      "command": ["crucible", "mcp", "--stdio"]
    }
  }
}
```

## Common Commands

```sh
crucible --help
crucible version
crucible update --dry-run
crucible vm status
crucible vm credentials
printf %s "$VM_PASSWORD" | crucible vm paste --stdin
crucible vm view --dry-run
crucible snapshot restore clean-base
crucible network status
```

`crucible vm credentials` prints generated Windows account credentials from host-only secret files.
Treat that output as sensitive. Use `crucible vm paste --stdin` to paste passwords into the focused
VM window without putting the secret itself in shell history.

## Source Checkout

Use a source checkout only when developing Crucible itself:

```sh
git clone https://github.com/Adamkadaban/crucible.git
cd crucible
scripts/check-host.sh
nvm install
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
```

From source, use `pnpm crucible ...` instead of the global binary.

## Safety

- Keep the default network mode isolated unless guest egress is intentional.
- Never mount host home directories, SSH agents, browser profiles, cloud credentials, or repository
  roots into the guest.
- Keep malware samples and generated artifacts outside Git and outside synced personal folders.
- Treat generated secrets, autounattend files, dumps, pcaps, and snapshots as local-only artifacts.
- Stop and restore `clean-base` after each sample unless you are intentionally continuing the same
  investigation.

See [`SECURITY.md`](./SECURITY.md) for reporting and containment guidance.

## Documentation

- [`docs/install.md`](./docs/install.md) - detailed install and first provision.
- [`docs/provisioning.md`](./docs/provisioning.md) - provisioning stages, realism mode, and E2E
  scope.
- [`docs/qemu.md`](./docs/qemu.md) - QEMU command shape and lifecycle state.
- [`docs/network-isolation.md`](./docs/network-isolation.md) - isolated, NAT, and capture modes.
- [`docs/protocol.md`](./docs/protocol.md) - guest agent mTLS HTTP API.
- [`docs/debugger.md`](./docs/debugger.md) - CDB-backed debugger workflows.
- [`docs/malware-analysis-sop.md`](./docs/malware-analysis-sop.md) - operating procedure.
- [`docs/teardown.md`](./docs/teardown.md) - cleanup boundaries.
- [`docs/threat-model.md`](./docs/threat-model.md) - assumptions and non-goals.

## Development

```sh
pnpm check
pnpm e2e
pnpm e2e:live  # opt-in; requires local Windows media and live VM config

cd guest-agent
go test ./...
go build ./...
```

## License

[MIT](./LICENSE)
