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
