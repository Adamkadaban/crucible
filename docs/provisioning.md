# Windows Provisioning Contracts

Phase 3 provisioning is contract-first. The current implementation defines the machine-readable
state, stage, script, result, and secret shapes that later work will execute against a real Windows
VM. The WinDbg provisioning scripts now exist, but CI tests inspect them with host-only fakes
instead of running a Windows VM.

## State Machine

Provisioning advances in this order:

1. `media-ready` verifies Windows install media and virtio media are present or explicitly
   overridden.
2. `vm-booted` verifies QMP sees a running VM and the QGA channel is configured.
3. `qga-ready` verifies QGA can respond and run PowerShell bootstrap checks.
4. `windbg-installed` verifies CDB, WinDbg, and the default symbol path.
5. `guest-agent-installed` verifies the Crucible guest service, its firewall rule, and mTLS
   material.
6. `policy-configured` verifies Defender, code-integrity, and test-signing states are recorded.
7. `local-accounts-created` verifies standard and admin execution accounts.
8. `health-checked` verifies debugger, service, execution-context, and policy health outputs.
9. `snapshot-prepared` verifies the guest is quiesced and clean snapshot metadata is ready.

Each stage starts as `pending`. A stage can become `running`, `succeeded`, `failed`, or `skipped`.
Any failure blocks the run instead of skipping ahead. The only successful terminal transition is
from `snapshot-prepared` to `complete`.

## Script Invocation

Provisioning script contracts identify the runner, executable, script path, argv, timeout, elevation
requirement, and redacted argv positions. Supported runners are:

- `host` for future Linux-host-side helpers.
- `qga-powershell` for bootstrap PowerShell through QEMU Guest Agent.
- `guest-agent-powershell` for steady-state PowerShell through the Crucible guest service.

PowerShell script invocations use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>`
plus stage-specific arguments. Later executors must return structured script results with status,
exit code, captured stdout/stderr, timestamps, and duration.

## WinDbg Provisioning

`guest/provision/install-windbg.ps1` installs debugger tooling and configures symbols for automated
debugger use:

- It first looks for existing `cdb.exe`, classic `windbg.exe`, and modern `WinDbgX.exe` in `PATH`,
  known Windows Kits debugger folders, the WindowsApps alias directory, and non-recursive
  `Microsoft.WinDbg_*` package directories.
- If either debugger is missing and `winget.exe` is available, it runs
  `winget install --id Microsoft.WinDbg --exact --accept-package-agreements --accept-source-agreements --disable-interactivity`.
- If winget is unavailable, or if CDB/WinDbg tooling is still incomplete after a winget install, it
  downloads the Windows SDK bootstrapper and installs only `OptionId.WindowsDesktopDebuggers`.
- It sets machine-wide `_NT_SYMBOL_PATH` to
  `srv*C:\Symbols*https://msdl.microsoft.com/download/symbols` by default and records
  `_NT_ALT_SYMBOL_PATH` as the local cache directory.
- It fails the provisioning stage unless CDB, a WinDbg executable, and the expected symbol path are
  discoverable after installation.

`guest/provision/test-windbg.ps1` is the standalone readiness detector for later health commands. It
emits compact JSON with `cdbPath`, `windbgPath`, `symbolPath`, `altSymbolPath`, and `healthy`, then
exits non-zero if any debugger or symbol-path check fails.

The install script accepts `-DryRun` so Linux CI can verify the provisioning plan and script content
without a Windows guest, package download, or debugger installation.

## Secrets

Generated Windows credentials and mTLS material are referenced through host-only secret records
under the configured `artifacts.secretsDirectory`. Secret files are contractually `0600` and are
recorded as `credential` artifacts in the artifact manifest. Tool and script results must redact
password, private-key, certificate PEM, and PFX password fields.

Defined secret kinds are:

- `windows-standard-password`
- `windows-admin-password`
- `mtls-ca-private-key`
- `mtls-ca-certificate`
- `mtls-host-client-private-key`
- `mtls-host-client-certificate`
- `mtls-guest-server-private-key`
- `mtls-guest-server-certificate`

## Not Implemented Yet

The contracts intentionally stop before real provisioning execution. Later Phase 3 work will add the
remaining PowerShell scripts, fake executors, real QGA and guest-service invocation, snapshot
operations, health commands, and the real-VM phase exit test.
