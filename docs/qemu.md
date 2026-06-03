# QEMU Plan

Crucible plans QEMU before it launches anything. Dry-run commands print the exact argv and socket
paths that lifecycle code will execute.

```sh
pnpm crucible vm create --dry-run
pnpm crucible vm start --dry-run
pnpm crucible vm status
pnpm crucible vm view --dry-run
pnpm crucible vm start
pnpm crucible vm logs
pnpm crucible vm stop
pnpm crucible snapshot create clean-base
pnpm crucible snapshot list
pnpm crucible snapshot restore clean-base
```

The default QEMU plan uses:

- `qemu-system-x86_64`
- KVM acceleration with `-machine type=q35,accel=kvm`
- host CPU passthrough with `-cpu host`
- a qcow2 disk at `artifacts/disks/crucible-win11.qcow2`
- restricted QEMU user-mode networking in isolated mode for host control only
- `virtio-scsi-pci` plus `scsi-hd` for the OS disk
- `virtio-serial-pci` for guest channels
- a QMP Unix socket at `artifacts/qmp.sock`
- a QGA virtserial channel backed by `artifacts/qga.sock`
- `virtio-balloon-pci` and `virtio-rng-pci` unless disabled in config

Use `virtio.diskBus` to select the disk transport:

```json
{
  "virtio": {
    "diskBus": "virtio-blk"
  }
}
```

`virtio-scsi` remains the default because it leaves room for additional attached media and disks
without changing the primary disk model. `virtio-blk` is available for simpler single-disk layouts.

Operators can append QEMU arguments through `vm.extraQemuArgs`:

```json
{
  "vm": {
    "extraQemuArgs": ["-display", "none"]
  }
}
```

Extra arguments are appended after Crucible's required lifecycle devices so dry-run output clearly
shows both the managed baseline and operator overrides.

When `network.mode` is `isolated`, the planner emits `virtio-net-pci` connected to a QEMU user-mode
netdev with `restrict=on`, `net=192.0.2.0/29`, `dhcpstart=192.0.2.2`, and a host-control `hostfwd`
from `127.0.0.1:<controlPort>` to `192.0.2.2:<controlPort>`. This keeps the guest NIC present for
the control plane without granting general egress or requiring a host interface with `192.0.2.1`.
When `network.mode` is `nat`, the planner uses the same QEMU user-mode netdev with `restrict=off` so
egress is an explicit operator choice. When `network.mode` is `capture`, it emits a tap-backed
netdev contract for later packet-capture work. See `docs/network-isolation.md` for the network model
contracts.

## Lifecycle State

The lifecycle manager consumes the QEMU plan rather than provisioning Windows directly. On start it
creates the lifecycle directories, launches QEMU detached, writes a pid file, appends QEMU stdout
and stderr to configured log files, and records both lifecycle state and artifact manifests.

The default state paths are:

- `artifacts/state/<vm-name>.json` for the current lifecycle state
- `artifacts/manifest.json` for tracked lifecycle artifacts
- `artifacts/run/<vm-name>.pid` for the QEMU pid
- `artifacts/logs/<vm-name>.stdout.log` and `artifacts/logs/<vm-name>.stderr.log` for QEMU output

Graceful shutdown uses QMP when possible. Stop sends `quit`; poweroff sends `system_powerdown`. When
QMP is unavailable, or when QEMU does not exit before the stop timeout, lifecycle cleanup sends
bounded host signals and escalates to `SIGKILL` after timeout. Stale pid and socket cleanup is
limited to project-owned paths and does not delete disks, snapshots, Windows ISOs, virtio media, or
operator sample directories.

CLI lifecycle commands map directly onto the core lifecycle manager:

- `vm create --dry-run` prints the qcow2 creation command and QEMU launch plan without touching disk
  state.
- `vm start --dry-run` prints the QEMU launch plan without starting QEMU.
- `vm start` launches QEMU detached and records pid, log, state, and artifact manifests.
- `vm status` reports process liveness and QMP status when the VM is running.
- `vm view` enables a loopback-only VNC endpoint on the running VM via QMP and opens a local viewer.
  The built-in viewer choices are `--viewer remote-viewer` and `--viewer vncviewer`; other local VNC
  clients can connect manually to the printed loopback endpoint. Use `vm view --dry-run` to inspect
  the endpoint and viewer command without touching QMP.
- `vm logs` prints the QEMU stdout and stderr logs, using `(missing)` before a log file exists.
- `vm stop` requests graceful QMP `quit`, `vm stop --poweroff` requests guest powerdown, and
  `vm stop --kill` force-kills the recorded process.

## Snapshots

Snapshot metadata is stored in the same artifact manifest as lifecycle resources. Each snapshot
record includes the QEMU tag, base qcow2 path, whether it is the `clean-base` snapshot, the snapshot
mode, and the last restore time when applicable.

`snapshot create [name]` defaults to `clean-base`. With an available QMP socket, Crucible sends
`stop`, `snapshot-save`, and `cont` so the VM is paused during the save point. If QMP is unavailable
before any snapshot command is sent, it falls back to `qemu-img snapshot -c <name> <disk>`, which is
safe for offline qcow2 disks and host-only tests.

`snapshot restore [name]` loads the manifest entry first. QMP-backed snapshots restore with `stop`,
`snapshot-load`, and `cont`. Offline qcow2 snapshots restore with
`qemu-img snapshot -a <name> <disk>`. Later malware-analysis workflow commands can depend on
`clean-base` as the standard restore target before and after executing samples.
