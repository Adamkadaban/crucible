# Contributing

Crucible is a Linux-hosted CLI and MCP server for controlling isolated Windows analysis VMs on QEMU/KVM.

## Build, Lint, Test

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cd guest-agent && go test ./... && go build ./...
```

Lint, typecheck, tests, and build must pass before opening a PR.

## Code Style

- Self-documenting code first. Clear names, small functions.
- Comments only when the why is non-obvious: tricky math, workarounds, invariants. Never narrate what the code does.
- No banner or decorative comments.
- Docstrings on non-trivial or exported APIs only.
- No TODO graveyards. Open an issue.
- Errors are never swallowed.
- Information flows one way: docs reference code, not the other way around. Do not add comments back-referencing removed planning files or other in-repo docs.

## Pull Requests

- Branch per change. Use Conventional Commits for every commit and PR title: `type(scope): subject`.
- Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `style`.
- Breaking changes use `type!:` with a `BREAKING CHANGE:` footer.
- One PR per logical change. Squash-merge to `main`.
- Lint, typecheck, tests, and build pass locally before opening.
- Update `README.md` and affected docs in the same PR as code changes.
- CI runs automatically on PRs; merge only when checks are green.

## Issues

For non-trivial changes, file an issue first. For small fixes, open a pull request against an
existing issue.

AI agents are welcome and must follow this file like any other contributor.
