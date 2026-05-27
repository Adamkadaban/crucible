# Windows Media Setup

## Host Packages

Crucible's host lifecycle commands run only on Linux with KVM. Install packages that provide
`qemu-system-x86_64`, `qemu-img`, firmware, and `/dev/kvm` access before provisioning media or
starting a VM. On Debian or Ubuntu hosts:

```sh
sudo apt-get install qemu-system-x86 qemu-utils ovmf
scripts/check-host.sh
```

Other distributions may split these packages differently. The host check reports the exact missing
binaries or KVM device without changing the host.

## Installation Media

`crucible media:plan` describes the installation media needed before provisioning a VM. The default
profile uses Windows 11 Enterprise Evaluation and the stable virtio-win ISO. The alternate
`windows-server-2025-eval` profile uses Windows Server Evaluation with the same virtio defaults.

Pass `--manual` to include profile-specific manual download URLs. Manual downloads are expected when
Microsoft evaluation links require registration, redirects, or anti-bot checks. In that case,
download the files shown by `crucible media:plan --manual` and place them at the printed cache
paths, or configure explicit overrides in `crucible.config.json`.

```json
{
  "media": {
    "cacheDir": "media/cache",
    "profile": "windows11-enterprise-eval",
    "windowsIso": { "path": "/isos/Windows11EnterpriseEvaluation.iso" },
    "virtioIso": { "url": "https://example.com/virtio-win.iso" },
    "driverBundle": { "path": "/drivers/virtio-win-guest-tools.exe" }
  }
}
```

`windowsIso` and `virtioIso` overrides must be `.iso` files, case-insensitively. `driverBundle`
overrides may be `.iso`, `.exe`, `.zip`, or `.msi` files, also case-insensitively. Each override may
include a `sha256` field for later verification.

Dry-run the full host-side Phase 1 plan before provisioning:

```sh
pnpm crucible media:plan --manual
pnpm crucible vm:create --dry-run
pnpm crucible vm:start --dry-run
```

`vm:create --dry-run` shows the qcow2 creation command and QEMU launch argv. `vm:start --dry-run`
shows the launch argv only. Neither command downloads media, creates disks, or starts a VM.

## Provisioning Outline

Windows provisioning is currently contract-first. The planned flow is media readiness, VM boot, QGA
readiness, WinDbg/CDB installation, guest agent installation, analysis policy changes, local account
creation, health checks, and clean snapshot preparation. Generated Windows account credentials and
mTLS files are host-only secrets under `artifacts.secretsDirectory`, not repository files or guest
shared-folder contents.

The WinDbg stage now has PowerShell scripts for installing debugger tooling with
`winget install Microsoft.WinDbg` or a Windows SDK Debugging Tools fallback, configuring
`_NT_SYMBOL_PATH`, and detecting `cdb.exe`/`windbg.exe` readiness.

The analysis policy stage disables Defender policy, records observed code-integrity policy state,
confirms test signing is disabled, and can apply optional malware-reversing profile settings such as
hostname, locale, sleep behavior, Explorer visibility, and low-risk lab camouflage. Username and
screen size are currently audit labels for later account/display provisioning. See
[`provisioning.md`](./provisioning.md) for the stage, script contract, config, and audit details.
