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
pnpm crucible vm:create --dry-run
pnpm crucible vm:start --dry-run
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
    "diskGiB": 128,
    "extraQemuArgs": []
  },
  "media": {
    "cacheDir": "media/cache",
    "profile": "windows11-enterprise-eval",
    "windowsIso": { "path": "/isos/Windows11EnterpriseEvaluation.iso" },
    "virtioIso": { "path": "/isos/virtio-win.iso" }
  },
  "virtio": {
    "diskBus": "virtio-scsi",
    "networkDevice": "virtio-net-pci",
    "balloon": true,
    "rng": true
  },
  "qmp": {
    "socketPath": "artifacts/qmp.sock"
  },
  "qga": {
    "socketPath": "artifacts/qga.sock"
  },
  "network": {
    "mode": "isolated"
  }
}
```

If automated downloads are blocked, `crucible media:plan` prints manual download URLs and the cache
paths where the files should be placed.

## QEMU Dry Runs

`crucible vm:create --dry-run` and `crucible vm:start --dry-run` render the planned qcow2 creation
and QEMU command without launching a VM. The default plan uses `qemu-system-x86_64` with KVM
acceleration, a qcow2 disk at `artifacts/disks/crucible-win11.qcow2`, no network device in isolated
mode, `virtio-scsi`, `virtio-serial`, a QMP Unix socket at `artifacts/qmp.sock`, and a QGA
virtserial channel backed by `artifacts/qga.sock`.

Set `virtio.diskBus` to `virtio-blk` to use `virtio-blk-pci` instead of the default
`virtio-scsi-pci`/`scsi-hd` pair. `vm.extraQemuArgs` is appended at the end of the generated argv so
operators can add explicit QEMU flags while keeping Crucible's required lifecycle devices visible in
dry-run output.

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
