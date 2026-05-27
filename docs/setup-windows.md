# Windows Media Setup

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
