# Teardown

`scripts/teardown.sh` removes the ephemeral state Crucible writes during a session — and _only_ that
state. Operator-owned artifacts (qcow2 disks, secrets, boot/autounattend bundle) are left intact so
the operator can decide when to delete them.

## What it touches

- Sends SIGTERM to the QEMU pid stored in `artifacts/run/*.pid` (only when `ps -p <pid> -o comm=`
  confirms the process is `qemu-system-*`).
- Removes the QMP / QGA / monitor sockets at `artifacts/{qmp,qga,mon}.sock`.
- Removes `artifacts/state/`, `artifacts/logs/`, `artifacts/run/`.
- Removes `artifacts/dbg-*.{png,ppm}`, `artifacts/screen-*.{png,ppm}`, `artifacts/poll*.log`,
  `artifacts/provision*.log`.

## What it leaves alone

- `artifacts/disks/*.qcow2` — operator owns the bytes.
- `artifacts/boot/` — autounattend ISO, drivers, OVMF vars copy.
- `artifacts/secrets/` — per-VM credentials. Use `rotateLocalAccountCredentials` if you want fresh
  secrets.
- `snapshots/` — qcow2 snapshot store.

## Modes

```sh
scripts/teardown.sh --dry-run   # prints DRY: lines for every action
scripts/teardown.sh             # actually removes the ephemeral state
scripts/teardown.sh --help      # prints the file list above
```

The CI workflow does not call `teardown.sh`; it runs against ephemeral GitHub-Actions runners and
never produces these files. Use the script locally between provisioning runs to reclaim disk space
and clear stale sockets.

## When to use

- Between `pnpm crucible provision` runs when a previous attempt left sockets behind.
- After a failed provision that left a `qemu-system-x86_64` orphan attached to the artifacts.
- Before sharing a workspace tarball (with `scripts/package-release.sh` in addition).
