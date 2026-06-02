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
guest agent, and exposes VM control through both a CLI and MCP server.

Use it for local malware-analysis and Windows debugging workflows where you control the host. Do not
treat it as a hard containment boundary against VM escapes or host-kernel bugs.

## Requirements

- Linux host with KVM access.
- QEMU, OVMF, `swtpm`, `socat`, and `xorriso`.
- A Windows installer ISO and virtio-win ISO that you provide locally.

Debian / Ubuntu package baseline:

```sh
sudo apt install qemu-system-x86 qemu-utils ovmf swtpm socat xorriso
```

## Install

```sh
npm install -g @adamkadaban/crucible
crucible --help
crucible doctor
crucible setup host --print
```

The npm package includes the CLI, MCP server, provisioning scripts, and a Windows x64 guest-agent
binary. You still need a Linux/KVM host and local Windows + virtio media.

Source checkouts also need Node from `.nvmrc`, pnpm via Corepack, and Go for guest-agent builds.

Create `crucible.config.json` in the directory where you will run Crucible, edit the media paths,
then provision with the global CLI:

```sh
crucible config init
crucible provision
crucible guest health
crucible snapshot list
crucible snapshot restore clean-base
```

## Source Checkout

```sh
git clone https://github.com/Adamkadaban/crucible.git
cd crucible

scripts/check-host.sh
nvm install
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
CRUCIBLE_VERSION=$(node -p "require('./package.json').version") scripts/package-release.sh
```

Create `crucible.config.json` with your local media paths:

```sh
pnpm crucible config init
```

`crucible.config.json`, VM disks, generated credentials, snapshots, dumps, pcaps, symbols, and
downloaded tool archives are ignored by Git.

From a source checkout, use the package script wrapper instead of the global binary:

```sh
pnpm crucible provision
pnpm crucible guest health
pnpm crucible snapshot list
```

The first provision usually takes 12-18 minutes. On success Crucible creates a `clean-base`
snapshot. Restore it before each new analysis session:

```sh
pnpm crucible snapshot restore clean-base
```

## MCP Server

Run the MCP server over stdio:

```sh
crucible mcp --stdio
```

To configure MCP clients, use one of the setup helpers. They are idempotent for supported config
files and print the file they update:

```sh
crucible setup opencode
crucible setup claude
crucible setup codex --print
crucible setup copilot --print
```

Example client config:

```json
{
  "mcpServers": {
    "crucible": {
      "command": "crucible",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

Useful MCP tools include `vm_status`, `vm_start`, `vm_stop`, `snapshot_list`, `snapshot_restore`,
`guest_health`, `guest_exec`, `guest_upload_file`, `guest_download_file`, `debug_open`,
`debug_command`, `debug_dump`, `dump_process`, `memory_scan`, and network/ProcMon inspection
helpers.

User-mode CDB automation is supported. KD/KDNET tooling is installed and reported in health output,
but kernel-debugging workflows are not implemented yet.

If your MCP client does not inherit the shell environment, point it at `scripts/opencode-mcp.sh` or
an equivalent wrapper that loads `nvm` and Corepack before running `pnpm crucible mcp --stdio`.

## Common Commands

```sh
pnpm crucible --help
crucible --help
pnpm crucible media plan --manual
pnpm crucible vm start --dry-run
pnpm crucible vm status
pnpm crucible vm logs
pnpm crucible vm stop
pnpm crucible network status
pnpm crucible snapshot restore clean-base
```

The older colon spellings such as `crucible vm:status` still work for compatibility, but docs prefer
the space-separated command style.

## Safety Notes

- Keep the default network mode isolated unless guest egress is intentional.
- Never mount host home directories, SSH agents, browser profiles, cloud credentials, or repository
  roots into the guest.
- Keep malware samples and generated artifacts outside Git and outside synced personal folders.
- Treat `artifacts/secrets/`, `artifacts/boot/Autounattend.xml`, and
  `artifacts/boot/autounattend.iso` as secret-equivalent local files.
- Stop and restore `clean-base` after each sample unless you are intentionally continuing the same
  investigation.

See [`SECURITY.md`](./SECURITY.md) for reporting and containment guidance.

## Documentation

- [`docs/install.md`](./docs/install.md) - detailed source install and first provision.
- [`docs/provisioning.md`](./docs/provisioning.md) - provisioning stages and contracts.
- [`docs/qemu.md`](./docs/qemu.md) - QEMU command shape and lifecycle state.
- [`docs/network-isolation.md`](./docs/network-isolation.md) - isolated, NAT, and capture modes.
- [`docs/protocol.md`](./docs/protocol.md) - guest agent mTLS HTTP API.
- [`docs/debugger.md`](./docs/debugger.md) - CDB-backed debugger workflows.
- [`docs/malware-analysis-sop.md`](./docs/malware-analysis-sop.md) - malware-analysis operating
  procedure.
- [`docs/teardown.md`](./docs/teardown.md) - cleanup boundaries.
- [`docs/threat-model.md`](./docs/threat-model.md) - assumptions and non-goals.

## Development

```sh
pnpm check

cd guest-agent
go test ./...
go build ./...
```

## License

[MIT](./LICENSE)
