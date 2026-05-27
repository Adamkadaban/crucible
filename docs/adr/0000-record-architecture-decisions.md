# 0000. Record Architecture Decisions

## Status

Accepted

## Context

Crucible will accumulate security-sensitive VM lifecycle, guest-control, provisioning, and debugger
automation decisions. Those decisions need to remain discoverable after implementation details move
across files.

## Decision

Use MADR-format ADRs in `docs/adr/` for non-trivial architectural decisions.

## Consequences

- Before contradicting a prior architectural choice, list `docs/adr/` and read anything related.
- Write an ADR when choosing between named alternatives, rejecting a library/framework/pattern that
  future work might reintroduce, committing to a backend/protocol/schema/interface that is hard to
  swap later, or recording a tried-and-rejected approach.
- ADRs are immutable once accepted. Superseding decisions get a new ADR that links the old one.

## Alternatives

- Keep decisions only in `PLAN.md`; rejected because the plan should track execution state, not
  every durable design rationale.
- Keep decisions only in `NOTES.md`; rejected because notes are chronological operational memory and
  become noisy for architectural lookup.
