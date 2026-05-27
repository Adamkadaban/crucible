# Windows Provisioning Contracts

Phase 3 provisioning is contract-first. The current implementation defines the machine-readable
state, stage, script, result, and secret shapes that later work will execute against a real Windows
VM. WinDbg, account, and service provisioning scripts are present and fixture-tested, but CI tests
inspect them with host-only fakes instead of running a Windows VM.

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

`writeWindowsAccountSecrets` creates the standard and admin execution account JSON files under the
host secrets root. The default account names are `CrucibleUser` and `CrucibleAdmin`. Passwords are
generated on the host, meet Windows complexity requirements, and are not passed on PowerShell argv.
The local-account script reads them from process environment variables named
`CRUCIBLE_STANDARD_PASSWORD` and `CRUCIBLE_ADMIN_PASSWORD`.

Defined secret kinds are:

- `windows-standard-password`
- `windows-admin-password`
- `mtls-ca-private-key`
- `mtls-ca-certificate`
- `mtls-host-client-private-key`
- `mtls-host-client-certificate`
- `mtls-guest-server-private-key`
- `mtls-guest-server-certificate`

## Local Accounts

`guest/provision/create-local-accounts.ps1` creates or updates two local accounts:

- `CrucibleUser` is a standard execution account and is removed from the local Administrators group
  if it was previously elevated.
- `CrucibleAdmin` is an admin execution account and is added to the local Administrators group.

The script is idempotent and emits JSON with account names and privilege flags only. It does not
print passwords. The provisioning executor must inject the two password environment variables from
the matching host secret files and clear the environment after the QGA or guest-agent command exits.

## Guest Agent Service

`guest/provision/install-agent.ps1` registers `CrucibleGuestAgent` as an automatic Windows service
after the guest agent executable and mTLS files have already been staged. It expects these files in
`C:\ProgramData\Crucible\Agent\certs` by default:

- `ca.cert.pem`
- `guest-server.cert.pem`
- `guest-server.key.pem`

The service listener is bound to the configured guest control address and port. The Windows firewall
rule is inbound TCP only, scoped to the configured local control address, local port, and the
host-only source address. The script rejects wildcard host-only source addresses such as `0.0.0.0`
or `::`.

OpenSSH remains a bootstrap fallback for environments where QGA cannot complete early provisioning.
It is not the steady-state control plane and is not opened by the account or service scripts.

## Not Implemented Yet

The contracts and scripts intentionally stop before full provisioning execution. Later Phase 3 work
will add the remaining PowerShell scripts, fake executors, real QGA and guest-service invocation,
snapshot operations, health commands, and the real-VM phase exit test.
