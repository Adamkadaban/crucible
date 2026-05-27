# QEMU Plan

Crucible plans QEMU before it launches anything. Phase 1 dry-run commands print the exact argv and
socket paths that later lifecycle code will execute.

```sh
pnpm crucible vm:create --dry-run
pnpm crucible vm:start --dry-run
pnpm crucible vm:status
pnpm crucible vm:start
pnpm crucible vm:logs
pnpm crucible vm:stop
```

The default QEMU plan uses:

- `qemu-system-x86_64`
- KVM acceleration with `-machine type=q35,accel=kvm`
- host CPU passthrough with `-cpu host`
- a qcow2 disk at `artifacts/disks/crucible-win11.qcow2`
- no network device in isolated mode
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

When `network.mode` is `nat` or `capture`, the current planner emits `virtio-net-pci` connected to a
QEMU user-mode netdev. Isolated mode intentionally omits `-netdev` and the NIC device so there is no
default guest egress path.

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

- `vm:create --dry-run` prints the qcow2 creation command and QEMU launch plan without touching disk
  state.
- `vm:start --dry-run` prints the QEMU launch plan without starting QEMU.
- `vm:start` launches QEMU detached and records pid, log, state, and artifact manifests.
- `vm:status` reports process liveness and QMP status when the VM is running.
- `vm:logs` prints the QEMU stdout and stderr logs, using `(missing)` before a log file exists.
- `vm:stop` requests graceful QMP `quit`, `vm:stop --poweroff` requests guest powerdown, and
  `vm:stop --kill` force-kills the recorded process.
