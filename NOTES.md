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

## 2026-05-27 — WinDbg winget package may not provide CDB

**Resolution:** Keep `winget install Microsoft.WinDbg` as the preferred WinDbg path, but verify both
CDB and a WinDbg executable after winget and use SDK Debugging Tools as a backstop when tooling is
incomplete. `guest/provision/install-windbg.ps1:176` · PR #62
