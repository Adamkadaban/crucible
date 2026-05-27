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
pnpm crucible provision
pnpm crucible mcp
```

## Configuration

The planned config file is `crucible.config.json`. It will support custom Windows ISOs, virtio ISOs,
driver bundles, QEMU arguments, media cache paths, and provisioning preferences.

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
