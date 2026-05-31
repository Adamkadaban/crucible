# Install

Crucible runs on a Linux host with KVM, packages a Windows analysis VM inside QEMU, and exposes its
MCP server over stdio. The npm package installs the CLI, MCP server, provisioning scripts, and a
Windows x64 guest-agent binary.

## npm install

```sh
npm install -g crucible
crucible --help
```

Use a source checkout only when developing Crucible itself.

## Linux host prerequisites

`scripts/check-host.sh` validates the following at any time:

- Linux (verified on Debian 13).
- `qemu-system-x86_64`, `qemu-img`, `xorriso`, `swtpm`, `socat` on `PATH`.
- `/dev/kvm` readable + writeable by the operator user.
- An OVMF firmware image (`/usr/share/OVMF/OVMF_CODE_4M.fd` or the Fedora / Arch variants enumerated
  in `packages/core/src/host-check.ts`).

Apt one-liner for Debian / Ubuntu:

```sh
sudo apt install qemu-system-x86 qemu-utils ovmf swtpm socat xorriso
```

## Windows + virtio media

You must supply the Windows installer ISO and the virtio drivers ISO yourself; Crucible never
downloads them on the operator's behalf.

1. Download a Windows 11 ISO. Enterprise Evaluation is a good default.
2. Download the latest stable virtio-win ISO and the virtio-win guest tools installer from
   https://github.com/virtio-win/virtio-win-pkg-scripts.
3. Generate `crucible.config.json` and replace the media paths:

```sh
crucible config:init
```

```json
{
  "media": {
    "windowsIso": { "path": "/path/to/windows.iso" },
    "virtioIso": { "path": "/path/to/virtio-win.iso" },
    "driverBundle": { "path": "/path/to/virtio-win-guest-tools.exe" }
  }
}
```

`crucible.config.json` is `.gitignore`d; per-host paths never land in version control.

## Node + Go toolchains

These are required for development from source. Normal npm users do not need Go to provision a VM;
the package includes the Windows guest-agent binary.

```sh
nvm install                # uses .nvmrc → Node 24
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
go version                  # 1.25+ required for the guest agent
```

The repo runs the same `pnpm check` on developer machines and in CI
(`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`).

## MCP client wiring

See the `## MCP Server` section of `README.md` for an MCP client snippet. The bare-minimum command
is:

```sh
crucible mcp --stdio
```

To wire the `guest_*` tools to a live agent, export:

```sh
export CRUCIBLE_GUEST_BASE_URL="https://127.0.0.1:8443"
export CRUCIBLE_GUEST_CA_PATH="artifacts/secrets/<vm>/mtls/ca.cert.pem"
export CRUCIBLE_GUEST_CERT_PATH="artifacts/secrets/<vm>/mtls/host-client.cert.pem"
export CRUCIBLE_GUEST_KEY_PATH="artifacts/secrets/<vm>/mtls/host-client.key.pem"
```

## First provision

```sh
crucible provision
crucible guest:health
crucible snapshot:list
```

The CLI generates a per-VM mTLS PKI under `artifacts/secrets/<vm>/mtls/` on first run (CA + server
cert SAN'd to the host-only control address + host client cert), bakes the cert material, guest
agent binary, and provisioning scripts into `artifacts/boot/crucible-payload.iso`, and mounts that
payload as read-only guest media for `install-agent.ps1` and the other provisioning stages. Override
the bundled/source guest-agent binary with `CRUCIBLE_GUEST_AGENT_BINARY` if needed.

The first run takes ~12-18 minutes for Windows install, auto-login, tool setup, policy lockdown, and
guest-agent install. On success, Crucible creates `clean-base`; restore it before each new analysis
session.

To wire MCP tools at the live agent, point the env vars at the generated bundle before starting the
MCP server:

```sh
export CRUCIBLE_GUEST_BASE_URL="https://127.0.0.1:8443"   # via the hostfwd
export CRUCIBLE_GUEST_CA_PATH="artifacts/secrets/<vm>/mtls/ca.cert.pem"
export CRUCIBLE_GUEST_CERT_PATH="artifacts/secrets/<vm>/mtls/host-client.cert.pem"
export CRUCIBLE_GUEST_KEY_PATH="artifacts/secrets/<vm>/mtls/host-client.key.pem"
```
