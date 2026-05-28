# Changelog

All notable changes to Crucible. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to
[Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added

- Beta readiness: `scripts/package-release.sh` builds the Node packages, cross-compiles the Go guest
  agent for Windows, and emits a SHA-256 release manifest under `dist/release/`.
- `scripts/teardown.sh` (+ `--dry-run` / `--help`) removes ephemeral Crucible state (sockets, state,
  run logs, debug screenshots) without touching operator-owned disks, secrets, snapshots, or boot
  media.
- Docs: `docs/install.md`, `docs/upgrade.md`, `docs/teardown.md`.

### Changed

- PLAN.md tracks the per-phase deliverable closure with explicit deferred notes for the items that
  intentionally land in follow-ups (capture-mode pcap hook, guest_exec_admin, real-VM MCP
  integration tests, CLI subcommands for rotation/export).

### Verified

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes on Linux.
- `go vet ./... && go test ./...` and `GOOS=windows GOARCH=amd64 go build` pass in CI for
  `guest-agent/`.
- `scripts/check-host.sh` and `scripts/teardown.sh --dry-run` exit 0 on a clean Debian 13
  workstation.
- The Phase 3 real-VM exit test is still outstanding (#67) — the boot fixes from #100 / #101 / #103
  / #104 / #105 / #106 land the path to a desktop, but a fully automated
  `pnpm crucible provision && snapshot:create && snapshot:restore && guest:health` cycle has not yet
  completed.
