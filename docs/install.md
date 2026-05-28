# Install

Crucible runs on a Linux host with KVM, packages a Windows analysis VM inside QEMU, and exposes its
MCP server over stdio. Beta installs follow the same shape as the development checkout — there is no
separate distribution channel today.

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

1. Download a Windows 11 ISO (Enterprise Evaluation is fine).
2. Download the latest stable virtio-win ISO and the virtio-win guest tools installer from
   https://github.com/virtio-win/virtio-win-pkg-scripts.
3. Drop both files anywhere on disk and record the paths in `crucible.config.json` at the workspace
   root:

```json
{
  "media": {
    "windowsIso": { "path": "/abs/path/Win11_25H2_English_x64_v2.iso" },
    "virtioIso": { "path": "/abs/path/virtio-win-0.1.285.iso" },
    "driverBundle": { "path": "/abs/path/virtio-win-guest-tools.exe" }
  }
}
```

`crucible.config.json` is `.gitignore`d; per-host paths never land in version control.

## Node + Go toolchains

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

See the `## MCP server` section of `README.md` for the `claude_desktop_config.json` snippet. The
bare-minimum command is:

```sh
pnpm crucible mcp --stdio
```

To wire the `guest_*` tools to a live agent, export:

```sh
export CRUCIBLE_GUEST_BASE_URL="https://192.0.2.2:8443"
export CRUCIBLE_GUEST_CA_PATH="artifacts/secrets/<vm>/mtls/ca.pem"
export CRUCIBLE_GUEST_CERT_PATH="artifacts/secrets/<vm>/mtls/host-client.pem"
export CRUCIBLE_GUEST_KEY_PATH="artifacts/secrets/<vm>/mtls/host-client.key"
```

## First provision

```sh
# Build the guest agent binary once; the CLI looks it up at
# dist/release/crucible-guest-agent.exe by default. Override via
# $CRUCIBLE_GUEST_AGENT_BINARY for custom layouts.
scripts/package-release.sh

pnpm crucible provision
```

The CLI generates a per-VM mTLS PKI under `artifacts/secrets/<vm>/mtls/` on first run (CA + server
cert SAN'd to the host-only control address + host client cert), stages the cert material and the
`crucible-agent.exe` binary into the guest via `qemu-ga guest-file-*`, and then runs
`install-agent.ps1`.

The first run takes ~12–18 minutes (Windows install + auto-login + agent install). Subsequent boots
are ~10–20 s because `clean-base` is snapshotted on success.

To wire MCP tools at the live agent, point the env vars at the generated bundle:

```sh
export CRUCIBLE_GUEST_BASE_URL="https://127.0.0.1:8443"   # via the hostfwd
export CRUCIBLE_GUEST_CA_PATH="artifacts/secrets/<vm>/mtls/ca.cert.pem"
export CRUCIBLE_GUEST_CERT_PATH="artifacts/secrets/<vm>/mtls/host-client.cert.pem"
export CRUCIBLE_GUEST_KEY_PATH="artifacts/secrets/<vm>/mtls/host-client.key.pem"
```
