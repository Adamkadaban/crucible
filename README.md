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

## Safety Warnings

- Treat the Windows guest as hostile after running any sample, exploit proof of concept, or unknown
  binary. Crucible reduces accidental exposure; it does not guarantee containment against QEMU/KVM
  or host kernel escapes.
- The default `network.mode` is `isolated` and must not allow guest Internet egress. Use `nat` only
  when live egress is intentional, and use `capture` only when packet capture artifacts are
  expected.
- Do not expose host home directories, SSH agents, cloud credentials, package tokens, browser
  profiles, or repository roots to the guest. Host shared folders are not part of the safe default.
- Keep malware samples, VM disks, snapshots, crash dumps, packet captures, symbol caches, and
  generated credentials out of Git and out of synced personal folders.
- Review dry-run QEMU output before launching with `vm.extraQemuArgs`; extra network, socket, or
  filesystem flags can bypass Crucible's containment assumptions.

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

The host must be Linux with KVM available. Install the distribution packages that provide QEMU,
qcow2 tooling, and KVM access before creating a VM:

```sh
sudo apt-get install qemu-system-x86 qemu-utils ovmf
scripts/check-host.sh
```

Package names vary by distribution, but the required binaries and devices are `qemu-system-x86_64`,
`qemu-img`, and `/dev/kvm`.

## Use

```sh
pnpm crucible --help
pnpm crucible media:plan
pnpm crucible media:plan --manual
pnpm crucible media:plan --profile windows-server-2025-eval
pnpm crucible net:plan --mode isolated
pnpm crucible net:teardown --dry-run
pnpm crucible vm:create --dry-run
pnpm crucible vm:start --dry-run
pnpm crucible vm:status
pnpm crucible vm:start
pnpm crucible vm:logs
pnpm crucible vm:stop
pnpm crucible provision
pnpm crucible snapshot:create clean-base
pnpm crucible guest:health
pnpm crucible snapshot:list
pnpm crucible snapshot:restore clean-base
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
    "display": { "mode": "none", "vncSocketPath": "artifacts/vnc.sock" },
    "extraQemuArgs": []
  },
  "media": {
    "cacheDir": "media/cache",
    "profile": "windows11-enterprise-eval",
    "windowsIso": { "path": "/isos/Windows11EnterpriseEvaluation.iso" },
    "virtioIso": { "path": "/isos/virtio-win.iso" },
    "driverBundle": { "path": "/drivers/virtio-win-guest-tools.exe" }
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
    "mode": "isolated",
    "controlPort": 8443
  }
}
```

`network.mode` accepts `isolated`, `nat`, or `capture`. `isolated` is the default and emits a
restricted QEMU user-mode NIC only for host control traffic, listening on `127.0.0.1:<controlPort>`
and forwarding to `192.0.2.2:<controlPort>` in the guest. `nat` is explicit guest egress through
unrestricted QEMU user networking with the same control-port mapping, and `capture` is a tap-backed
capture contract for later firewall and packet-capture work. See
[`docs/network-isolation.md`](./docs/network-isolation.md) and
[`docs/threat-model.md`](./docs/threat-model.md) for the Phase 2 network contracts and containment
boundaries.

`crucible net:plan --mode isolated` prints QEMU networking and firewall commands without mutating
the host. It defaults to nftables dry-run commands and project-owned chains/rules only. Pass
`--backend iptables` to render iptables commands, and pass `--apply` to also print the apply and
teardown command models after the dry-run commands. `net:plan` never executes the apply model.

`crucible net:teardown --dry-run` prints the idempotent teardown model for project-owned firewall
rules and tap interfaces. Missing resources are ignored, and teardown refuses resources that do not
match the current Crucible owner tag and teardown contract. Pass `--apply` to print the privileged
apply model after reviewing the dry run; the CLI still does not execute host firewall or interface
commands in Phase 2.

`crucible media:plan` reads `crucible.config.json` when present and prints the default Windows 11
Enterprise Evaluation ISO, stable virtio-win ISO, optional virtio guest tools bundle, and their
expected cache paths. Pass `--manual` to include profile-specific manual download URLs. Use
`"profile": "windows-server-2025-eval"` or `--profile windows-server-2025-eval` to select the
alternate Windows Server evaluation media.

Custom media overrides accept either `path` or `url`, plus optional `sha256`. Windows and virtio ISO
overrides must point to `.iso` files, case-insensitively. Driver bundle overrides may point to
`.iso`, `.exe`, `.zip`, or `.msi` files, also case-insensitively. If automated downloads are
blocked, place manually downloaded files at the cache paths printed by
`crucible media:plan --manual` or point `crucible.config.json` at operator-managed paths.

## QMP Control

Crucible controls QEMU through the local Unix socket at `qmp.socketPath`, defaulting to
`artifacts/qmp.sock`. The QMP client waits for QEMU's greeting, sends `qmp_capabilities`, adds
request IDs to commands, collects asynchronous events, and reports structured timeout, parse,
protocol, connection, and command errors.

The default QMP timeout is `5000` ms for connection, greeting negotiation, capabilities negotiation,
and commands. The parser rejects malformed JSON and unknown top-level message fields conservatively
while leaving command-specific payloads opaque for QEMU version compatibility. See
[`docs/protocol.md`](./docs/protocol.md) for details.

## Provisioning Contracts

Phase 3 wires `crucible provision`, `crucible snapshot:create <name>`,
`crucible snapshot:restore <name>`, and `crucible guest:health` through the Windows provisioning
contracts without requiring a real Windows VM in CI. The core package models the ordered stages for
media readiness, VM boot, QGA readiness, WinDbg/CDB/KD/KDNET/GFlags installation, dynamic analysis
tool reporting, local account creation, guest agent installation, analysis policy lockdown, health
checks, and clean snapshot preparation. Script contracts describe the runner, PowerShell argv,
timeout, elevation, environment-backed secret injection, and redaction behavior. Secret contracts
keep generated Windows credentials and mTLS material under the configured
`artifacts.secretsDirectory` as host-only `0600` files.

The WinDbg stage includes PowerShell scripts that prefer `winget install Microsoft.WinDbg`, fall
back to Windows SDK Debugging Tools, configure `_NT_SYMBOL_PATH`, and detect CDB, WinDbg, KD/KDNET,
GFlags, and symbol-cache readiness without requiring a real Windows VM in CI. The analysis-tools
stage installs or reports Windows-only/dynamic tooling such as Sysinternals and x64dbg before final
lockdown; static analysis tools such as Ghidra stay on the Linux host.

The analysis policy stage uses `guest/provision/configure-policy.ps1` for isolated analysis VMs. It
disables Windows Defender policy, applies and records code-integrity policy changes, forces test
signing off, and emits JSON audit output for readiness checks. Test signing has no enablement flag
in malware-analysis mode; any future driver-lab mode must add an explicit separate policy.

Optional `analysisPolicy.profile` settings can set the guest hostname, locale, sleep behavior,
Explorer visibility, recent-history clearing, and common analysis-lab camouflage. `username` and
`screenSize` are recorded as profile labels in audit output for later account/display provisioning;
they do not rename accounts or change resolution in this policy stage. See
[`docs/provisioning.md`](./docs/provisioning.md) for the config shape and audit fields.

The Windows account script creates a standard `CrucibleUser` context and an admin `CrucibleAdmin`
context from host-generated passwords that are not placed on command lines. The guest-agent service
script registers `CrucibleGuestAgent`, verifies staged mTLS files, and creates an inbound firewall
rule limited to the host-only source address and configured control port. OpenSSH remains a
bootstrap fallback only, not the steady-state control channel. See
[`docs/provisioning.md`](./docs/provisioning.md) for the full provisioning outline.

`crucible provision` starts the configured VM, executes the ordered provisioning stage contract via
the configured real-VM adapters, creates the `clean-base` snapshot, and prints guest-health contract
status. Until the QGA and guest-service adapters are configured on a real VM, the default executor
blocks at the first stage instead of pretending provisioning succeeded.

`crucible snapshot:create clean-base` and `crucible snapshot:restore clean-base` use the snapshot
manager described below. Snapshot metadata records the base disk, clean-baseline flag, QEMU tag,
snapshot mode, and restore time in the artifact manifest; VM disks and snapshots remain artifacts
outside Git.

`crucible guest:health` renders the readiness checks required by the `health-checked` stage:
debugger and dynamic-tool readiness, guest service health, standard/admin execution contexts, and
Defender / code-integrity / test-signing policy state. It exits non-zero unless the real guest
health path can confirm the VM is healthy. Clean snapshots are taken only after tooling setup,
account/service setup, policy lockdown, and health checks complete.

## VM Lifecycle State

The CLI lifecycle commands call the same core lifecycle manager used by later MCP tools. `vm:start`
launches the planned QEMU process, records its pid, writes stdout/stderr logs, and stores
machine-readable state under the configured artifact directory. `vm:status` prints the recorded pid,
process liveness, QMP availability, and lifecycle artifact paths. `vm:logs` prints the QEMU stdout
and stderr log files, reporting `(missing)` before the VM has produced logs. `vm:stop` prefers QMP
graceful shutdown by sending `quit`; `vm:stop --poweroff` sends `system_powerdown`; `vm:stop --kill`
sends `SIGKILL`. If QMP is unavailable or the process does not exit before the configured timeout,
the manager falls back to `SIGTERM` and then `SIGKILL`.

Default lifecycle artifacts are:

- state manifest: `artifacts/state/crucible-win11.json`
- artifact manifest: `artifacts/manifest.json`
- pid file: `artifacts/run/crucible-win11.pid`
- QMP socket: `artifacts/qmp.sock`
- QGA socket: `artifacts/qga.sock`
- stdout log: `artifacts/logs/crucible-win11.stdout.log`
- stderr log: `artifacts/logs/crucible-win11.stderr.log`

Cleanup is intentionally narrow: stale pid files and sockets are removed only for project-owned
paths and only when the recorded process is no longer alive. Disk images, Windows media, snapshots,
sample directories, and other operator-provided artifacts are not deleted by lifecycle cleanup. For
real malware work, prefer artifact and sample directories on a dedicated analysis volume rather than
under a shared home directory or cloud-synced path.

## Snapshots

`crucible snapshot:create [name]`, `crucible snapshot:list`, and `crucible snapshot:restore [name]`
manage QEMU/qcow2 snapshots and record their metadata in `artifacts/manifest.json`. The default name
is `clean-base`, matching the Phase 3 provisioning baseline and later malware workflow restore
point.

When QMP is available, snapshot creation and restore pause the VM, use QMP snapshot commands, and
resume execution. When QMP is unavailable before any snapshot command is sent, creation and restore
fall back to `qemu-img snapshot -c` and `qemu-img snapshot -a` against the configured qcow2 disk.
The manifest records the snapshot name, clean-base flag, base disk path, QEMU tag, mode, and last
restore time. Snapshot names are limited to short alphanumeric, `.`, `_`, and `-` names so they are
safe as QEMU tags and manifest keys.

## QEMU Dry Runs

`crucible vm:create --dry-run` renders the planned qcow2 creation and QEMU command without launching
a VM. `crucible vm:start --dry-run` renders only the QEMU command and sockets. The default plan uses
`qemu-system-x86_64` with KVM acceleration, a qcow2 disk at `artifacts/disks/crucible-win11.qcow2`,
restricted isolated networking with `restrict=on`, `net=192.0.2.0/30`, and
`hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443`, `virtio-scsi`, `virtio-serial`, a QMP Unix socket at
`artifacts/qmp.sock`, and a QGA virtserial channel backed by `artifacts/qga.sock`.

Set `virtio.diskBus` to `virtio-blk` to use `virtio-blk-pci` instead of the default
`virtio-scsi-pci`/`scsi-hd` pair. `vm.extraQemuArgs` is appended at the end of the generated argv so
operators can add explicit QEMU flags while keeping Crucible's required lifecycle devices visible in
dry-run output.

The default `vm.display.mode` is `none` so QEMU never opens a GTK window on the host (suitable for
servers, CI, and headless workstations). Set `vm.display.mode` to `gtk` for a local GUI while
debugging, or to `vnc` to expose the framebuffer over a Unix domain socket at
`vm.display.vncSocketPath` (default `artifacts/vnc.sock`). Connect with
`vncviewer unix=artifacts/vnc.sock` or `remote-viewer vnc+unix://$PWD/artifacts/vnc.sock`. QMP
`screendump` keeps working in every mode.

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

## MCP server

`crucible mcp --stdio` exposes the bootstrap tool set over an [MCP](https://modelcontextprotocol.io)
stdio transport so an LLM client (Claude Desktop, opencode, etc.) can drive provisioning, snapshots,
and guest commands.

Add to `~/.config/Claude/claude_desktop_config.json` (or the equivalent client config):

```json
{
  "mcpServers": {
    "crucible": {
      "command": "pnpm",
      "args": ["--filter", "@crucible/cli", "exec", "crucible", "mcp", "--stdio"],
      "cwd": "/path/to/crucible"
    }
  }
}
```

The currently registered tools are:

| Tool             | Purpose                                                      |
| ---------------- | ------------------------------------------------------------ |
| `host_check`     | Report Linux host prerequisites (QEMU/KVM, OVMF, virtio, …). |
| `guest_health`   | Hit `/health` on the Crucible guest agent.                   |
| `guest_exec`     | Run a bounded process inside the guest.                      |
| `guest_upload`   | Write a base64 payload into the guest staging directory.     |
| `guest_download` | Read a file back from staging.                               |

Every tool returns a structured JSON envelope of the form
`{ "ok": true, "result": { ... }, "auditLogPath": "..." }` on success and
`{ "ok": false, "error": { "kind": "...", "message": "...", "auditLogPath": "..." } }` on failure.
`error.kind` is one of `validation`, `host-prerequisite`, `vm-offline`, `guest-failed`, or
`internal`.

When mTLS material has been provisioned, point the guest tools at the live agent by exporting
`CRUCIBLE_GUEST_BASE_URL`, `CRUCIBLE_GUEST_CA_PATH`, `CRUCIBLE_GUEST_CERT_PATH`, and
`CRUCIBLE_GUEST_KEY_PATH` before launching `crucible mcp --stdio`. Without those, every guest tool
returns the `guest-failed` error explaining that no guest client is configured — useful for
dry-running the MCP wiring on hosts where no VM is online.

## MVP walkthrough (beta)

Quick start from a clean Debian 13 checkout:

```sh
# 1. Host prerequisites
sudo apt install qemu-system-x86 qemu-utils ovmf swtpm socat xorriso
scripts/check-host.sh

# 2. Node + Go toolchains
nvm install
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build

# 3. Configure media (see docs/install.md for details)
cp crucible.config.example.json crucible.config.json  # if you have an example
# edit crucible.config.json to point at your Windows + virtio ISOs

# 4. Provision the Windows VM
pnpm crucible provision      # ~12-18 minutes the first time
pnpm crucible snapshot:create clean-base
pnpm crucible guest:health

# 5. Drive the VM from an MCP client
pnpm crucible mcp --stdio

# 6. When done
scripts/teardown.sh          # removes ephemeral state, keeps disks/secrets/snapshots
```

The full operator playbook lives under `docs/`:

- `docs/install.md` — host prerequisites, media, toolchain, MCP wiring.
- `docs/provisioning.md` — provisioning stages + script contracts.
- `docs/setup-windows.md` — Windows + virtio caveats.
- `docs/qemu.md` — QEMU command shape + dry runs.
- `docs/network-isolation.md` — default-deny network modes.
- `docs/protocol.md` — guest agent mTLS HTTP API.
- `docs/debugger.md` — cdb-backed debugger session model.
- `docs/malware-analysis-sop.md` — policy + scenario runner SOP.
- `docs/upgrade.md` — host + guest agent upgrade flow.
- `docs/teardown.md` — what `scripts/teardown.sh` touches.
- `docs/threat-model.md` — assumptions + sample-handling boundaries.

## Release bundle

`scripts/package-release.sh` produces:

```
dist/release/
├── crucible-cli-<version>.tgz
├── crucible-core-<version>.tgz
├── crucible-mcp-server-<version>.tgz
├── crucible-guest-agent.exe          (windows/amd64)
└── release-manifest.json             (SHA-256 + size per artifact)
```

`CRUCIBLE_VERSION=<tag> scripts/package-release.sh` stamps the version into both the manifest and
the Go binary's `-X main.version`. The manifest is the canonical reference for downstream consumers.
