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

---

Crucible is a Linux-hosted MCP server and CLI for creating a disposable Windows desktop analysis VM
on QEMU/KVM, installing debugger tooling and a secure guest control service, then restoring clean
snapshots before and after malware-analysis or Windows vulnerability debugging work.

## Highlights

- **Linux-first host** - Uses QEMU/KVM, QMP, virtio devices, and host-only control paths.
- **Windows desktop default** - Targets Windows 11 Enterprise Evaluation for realistic
  malware-analysis behavior.
- **Secure guest control** - Plans a Go Windows service with mTLS, audited command execution, and
  file transfer.
- **Debugger automation** - Prefers CDB/command-line automation over an already-open WinDbg GUI.
- **Contained malware mode** - Defaults to isolated networking with no guest Internet egress.
- **Cached media** - Prints manual download links and supports custom Windows/virtio media paths.

## Install

```sh
nvm use && pnpm install
```

## Use

```sh
pnpm crucible --help
pnpm crucible media:plan
pnpm crucible media:plan --manual
pnpm crucible media:plan --profile windows-server-2025-eval
pnpm crucible provision
pnpm crucible mcp
```

## Configuration

The planned config file is `crucible.config.json`. The schema lives at `schemas/config.schema.json`
and covers VM sizing, media cache paths, custom Windows and virtio media, virtio device preferences,
extra QEMU arguments, QMP/QGA sockets, networking mode, and artifact directories.

```json
{
  "$schema": "./schemas/config.schema.json",
  "vm": {
    "name": "crucible-win11",
    "cpus": 4,
    "memoryMiB": 8192,
    "diskGiB": 128
  },
  "media": {
    "cacheDir": "media/cache",
    "profile": "windows11-enterprise-eval",
    "windowsIso": { "path": "/isos/Windows11EnterpriseEvaluation.iso" },
    "virtioIso": { "path": "/isos/virtio-win.iso" },
    "driverBundle": { "path": "/drivers/virtio-win-guest-tools.exe" }
  },
  "network": {
    "mode": "isolated"
  }
}
```

`crucible media:plan` prints the default Windows 11 Enterprise Evaluation ISO, stable virtio-win
ISO, optional virtio guest tools bundle, and their expected cache paths. Pass `--manual` to include
profile-specific manual download URLs. Use `"profile": "windows-server-2025-eval"` or
`--profile windows-server-2025-eval` to select the alternate Windows Server evaluation media.

Custom media overrides accept either `path` or `url`, plus optional `sha256`. Windows and virtio ISO
overrides must point to `.iso` files, case-insensitively. Driver bundle overrides may point to
`.iso`, `.exe`, `.zip`, or `.msi` files, also case-insensitively. If automated downloads are
blocked, place manually downloaded files at the cache paths printed by
`crucible media:plan --manual` or point `crucible.config.json` at operator-managed paths.

## Hacking On It

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Guest agent checks live in `guest/agent`:

```sh
go test ./...
go build ./...
```

## License

[MIT](./LICENSE)
