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
