# Notes

Append-only operational memory lives here. See the Operational Memory section in `AGENTS.md` for
entry format and read/write rules.

## Trusted issue authors

- Adamkadaban

Trusted author entries must match the GitHub `login` field exactly, including case. Do not normalize
casing before comparison.

## 2026-05-26 — Bootstrap uses Node 24 through nvm

**Resolution:** The local shell initially reported Node 20, but the project now pins `.nvmrc` to
Node 24.16.0 so Vitest 4 and current tooling run cleanly. `.nvmrc:1` · PR #5

## 2026-05-27 — Node socket write callback is not error-first

**Resolution:** QMP socket writes must rely on socket `error` events rather than treating the
`socket.write` callback as `(error) => void`; the callback receives no argument on successful flush.
`packages/core/src/qmp.ts` · issue #11

## 2026-05-27 — Lifecycle manager issue was #12, not #10

**Resolution:** Issue #10 is lifecycle CLI/docs and depends on the lifecycle manager; issue #12 is
the owner-authored lifecycle manager scope implemented in this branch. `PLAN.md:170` · issue #12

## 2026-05-27 — Copilot manual re-review can be unavailable

**Resolution:** Initial Copilot review worked through PR auto-request, but manual re-request after
fixes returned `requested:false` because Copilot is not enabled as a repo collaborator for manual
requests; resolve initial threads and report the re-review blocker. `AGENTS.md:70` · PR #52

## 2026-05-27 — Analysis policy is contract-tested without Windows

**Resolution:** The policy script emits JSON that host tests validate from fixtures, keeping
Defender/code-integrity/test-signing readiness CI-safe until the real-VM provisioning worktree wires
execution. `packages/core/src/analysis-policy.ts` · issue #59

## 2026-05-27 — Account passwords stay off provisioning argv

**Resolution:** Windows execution account passwords are generated into host-only secret JSON files
and injected into the account script through process environment variables so PowerShell argv and
stage contracts do not carry plaintext credentials. `packages/core/src/provisioning.ts` · issue #57

## 2026-05-27 — WinDbg winget package may not provide CDB

**Resolution:** Keep `winget install Microsoft.WinDbg` as the preferred WinDbg path, but verify both
CDB and a WinDbg executable after winget and use SDK Debugging Tools as a backstop when tooling is
incomplete. `guest/provision/install-windbg.ps1:176` · PR #62

## 2026-05-27 — Phase 3 real-VM exit remains externally blocked

**Resolution:** Provision, snapshot, restore, and guest health commands are wired through fakeable
contracts, but the real exit test still needs a configured Windows VM with QGA and guest-service
adapters. `PLAN.md:272` · issue #60

## 2026-05-27 — Snapshot fallback only before QMP mutation

**Resolution:** The snapshot manager falls back to `qemu-img snapshot` only when QMP is unavailable
before a snapshot command is sent; after a QMP pause/save/load attempt starts, errors are surfaced
so restore semantics do not silently mix online and offline modes. `packages/core/src/snapshot.ts` ·
issue #58

## 2026-05-28 — qemu-ga drops mid-provision when Windows reboots, breaking writeFile/exec

**Resolution:** Wrapped `QgaClient.writeFile` (always idempotent — same path, same bytes, mode=wb
truncates) and `QgaClient.exec` (opt-in `idempotent: true`) in a transport-level retry layer that
treats `PROCESS_TIMEOUT`, connect failures, and structured QGA errors mentioning
`pid|handle|not found|invalid` as transient. `QgaProvisioningExecutor` marks the New-Item mkdir and
every provisioning stage script as `idempotent: true`; existing guest scripts in
`guest/provision/*.ps1` were already designed idempotent. `packages/core/src/qga.ts:62-237` · issue
#67, PR #126

## 2026-05-28 — Provision hangs after silent QEMU exit ~6 min in

**Resolution:** Three independent bugs surfaced by the Phase 3 exit test, fixed together in #129.
(1) `-boot once=d,order=c` violates the QEMU manual's "should not be used together with bootindex"
rule; OVMF silently ACPI-shut-down the guest at `wpeutil reboot`. Dropped the `-boot` line; rely on
`bootindex=` exclusively (CD=1, disk=10). Added `-no-shutdown`, `-D <log>`,
`-d guest_errors,cpu_reset`, and `-debugcon file:<log>` so any future silent exit becomes
diagnosable. (2) `VmLifecycleManager.#buildStateManifest` always serialized `this.#plan.args`, so
any CLI subcommand built from a no-`bootMedia` default plan would clobber `state/<vm>.json`'s
`qemu.args` with the bare form when it ran stop/kill. Cleanup, stop, and kill paths now reuse the
manifest's existing `qemu` block instead. (3) `QgaClient.#withRetry`'s 5 min per-call budget burned
indefinitely against a dead socket; `connectSocket` left FIN_WAIT handles alive, wedging libuv.
Added `signal?: AbortSignal` to `QgaClientOptions` and a liveness poller in the CLI
(`startLifecycleLivenessPoller`) that aborts the signal when `processController.isAlive(pid)` flips
false OR when QMP `query-status` reports `shutdown`/`guest-panicked`/`internal-error`/`io-error`/
`watchdog` (necessary because `-no-shutdown` keeps the host process alive after a guest power-off so
pid-liveness alone is insufficient). Sockets are now `destroy()`'d instead of `end()`'d. The CLI
wraps the executor loop in try/catch that calls `lifecycleManager.kill()` on failure.
`packages/core/src/qemu.ts:81-100,141-158` ·
`packages/core/src/lifecycle.ts:280-302,304-360,398-447` ·
`packages/core/src/qga.ts:30-46,76-94,195-265,282` · `packages/cli/src/index.ts:357-470` · issue
#127, PR #129

## 2026-05-28 — Phase 3 exit test: CLI hang fixed; new guest-file-open error surfaces

**Resolution:** After #129 merged, real-VM provision no longer hangs indefinitely on QEMU exit
or stage failure. The CLI now exits with `ELIFECYCLE` and a real error message within ~9 min
on a failed stage (was: infinite hang requiring SIGKILL). Empirical confirmation in
`/tmp/crucible-provision.log` at 15:15. The remaining surfaced failure is a stage's
`writeFile` -> `guest-file-open` call returning a structured qga error; needs separate
investigation with stage-context in the error message. Filed as #130. `#67` remains open
until the full provision -> snapshot -> restore -> health flow completes end-to-end.
