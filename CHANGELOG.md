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
- Guest execution supports provisioned `standard` and `admin` Windows account contexts through the
  CLI and MCP `guest_exec_admin` surface.
- Docs: `docs/install.md`, `docs/upgrade.md`, `docs/teardown.md`.

### Changed

- Public beta docs replace bootstrap planning notes with stable operator and contributor guidance.

### Verified

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes on Linux.
- `go vet ./... && go test ./...` and `GOOS=windows GOARCH=amd64 go build` pass in CI for
  `guest-agent/`.
- `scripts/check-host.sh` and `scripts/teardown.sh --dry-run` exit 0 on a clean Debian 13
  workstation.
- Real-VM validation passed for provisioning, snapshot create/restore, live guest health, standard
  and admin guest execution, malware dry-run, and packaging.
