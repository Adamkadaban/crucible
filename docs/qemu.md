# QEMU Plan

Crucible plans QEMU before it launches anything. Phase 1 dry-run commands print the exact argv and
socket paths that later lifecycle code will execute.

```sh
pnpm crucible vm:create --dry-run
pnpm crucible vm:start --dry-run
```

The default QEMU plan uses:

- `qemu-system-x86_64`
- KVM acceleration with `-machine type=q35,accel=kvm`
- host CPU passthrough with `-cpu host`
- a qcow2 disk at `artifacts/disks/crucible-win11.qcow2`
- `virtio-net-pci` connected to a QEMU user-mode netdev, restricted in isolated mode
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
