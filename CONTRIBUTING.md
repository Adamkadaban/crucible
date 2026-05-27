# Contributing

See `AGENTS.md` for the actual project rules: commits, branching, reviews, worktrees, docs, and
quality gates.

See `PLAN.md` for the roadmap and phase checklist.

For non-trivial changes, file an issue first. For small fixes, open a pull request against an
existing issue.

Bootstrap a local checkout with:

```sh
nvm use
pnpm install
pnpm check
cd guest/agent && go test ./... && go build ./...
```

AI agents are welcome and must follow `AGENTS.md` like any other contributor.
