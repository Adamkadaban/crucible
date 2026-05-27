# Windows Provisioning Contracts

Phase 3 provisioning is contract-first. The current implementation defines the machine-readable
state, stage, script, result, policy-audit, and secret shapes that later work will execute against a
real Windows VM. The analysis VM policy script is present, but CI tests exercise it through static
contracts and JSON fixtures instead of requiring Windows.

## State Machine

Provisioning advances in this order:

1. `media-ready` verifies Windows install media and virtio media are present or explicitly
   overridden.
2. `vm-booted` verifies QMP sees a running VM and the QGA channel is configured.
3. `qga-ready` verifies QGA can respond and run PowerShell bootstrap checks.
4. `windbg-installed` verifies CDB, WinDbg, and the default symbol path.
5. `guest-agent-installed` verifies the Crucible guest service, its firewall rule, and mTLS
   material.
6. `policy-configured` disables Defender policy, records code-integrity policy state, confirms test
   signing is disabled, and records optional environment profile settings.
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

## Analysis VM Policy

`guest/provision/configure-policy.ps1` is the policy stage script for isolated analysis VMs. Its
contract keeps malware-analysis defaults intentionally unsafe inside the guest but visible in audit
output:

- Windows Defender policy and real-time monitoring are disabled for isolated analysis VMs.
- Code-integrity and HVCI policy state is changed and recorded.
- Test signing is forced off and must remain disabled by default. There is no config switch for
  enabling it; a future driver-lab mode must add an explicit separate policy.
- The script emits JSON with Defender, code-integrity, test-signing, profile, and warning fields.

The optional `analysisPolicy.profile` config section controls malware-reversing lab profile details:

- `hostname` and `username` labels for common lab personas.
- `locale`, defaulting to `en-US`.
- `screenSize`, defaulting to `1920x1080`.
- `disableSleep`, `showFileExtensions`, `showHiddenFiles`, `showExplorerRibbon`, and
  `clearRecentExplorerHistory`, all defaulting to `true`.
- `commonAnalysisLabCamouflage`, defaulting to `false`, which applies low-risk Explorer and desktop
  camouflage settings.

Host-side helpers parse the JSON audit output and produce readiness checks for `defender-disabled`,
`code-integrity-recorded`, `test-signing-disabled`, and `analysis-profile-audited`. These checks are
fixture-tested and do not require a real Windows VM in CI.

## Not Implemented Yet

The contracts intentionally stop before end-to-end real provisioning. Later Phase 3 work will add
fake executors, real QGA and guest-service invocation, snapshot operations, health commands, and the
real-VM phase exit test.
