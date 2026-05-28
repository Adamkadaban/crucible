# PLAN

## Overview

We are building a Linux-hosted MCP server that can provision, boot, control, snapshot, and restore a
fast Windows VM on QEMU/KVM for malware analysis and Windows vulnerability proof-of-concept
debugging. The server exposes non-interactive MCP tools for VM lifecycle, command execution as
standard or elevated users, file upload/download, and debugger automation without requiring WinDbg
to already be open; a small Windows guest service provides encrypted in-guest control while QMP/QGA
handle host-side VM lifecycle.

Assumptions made at bootstrap: the repository is private, the Linux host is x86_64 with KVM support,
the CLI binary is named `crucible`, the MVP defaults to a Windows 11 Enterprise Evaluation desktop
ISO URL and the stable virtio-win ISO URL cached under a local media cache, Windows Server
evaluation remains an alternate profile, operators can still supply their own Windows ISO and virtio
media paths, TypeScript/Node is the MCP host runtime, Go is acceptable for the Windows guest
service, and no external reference repositories are cloned into `references/` initially.

## Architecture

- `packages/mcp-server` is the TypeScript MCP server. It registers tools over stdio, validates
  inputs with Zod, calls VM lifecycle services, and returns structured results.
- `packages/core` is the TypeScript host orchestration library. It owns configuration loading, path
  layout, process execution with timeouts, QMP client behavior, QGA helpers, artifact manifests, and
  snapshot metadata.
- `packages/cli` is the `crucible` CLI for humans and integration tests. It exercises the same core
  APIs as the MCP tools and owns top-level commands such as `crucible provision` and `crucible mcp`.
- `guest/agent` is a Go Windows service. It runs inside the VM, exposes a localhost-or-host-only
  mTLS API, executes commands as standard or admin contexts, stages uploads/downloads, and wraps
  debugger commands.
- `guest/provision` contains PowerShell provisioning scripts for OpenSSH/QGA prerequisites, WinDbg
  installation, the guest agent service, local accounts, firewall rules, and first snapshot
  preparation.
- `docs/` contains operator-facing setup, network isolation, threat model, protocol notes, and ADRs.
- `test/` contains host-only fakes plus optional real-VM integration tests gated by environment
  variables. Unit tests must not require Windows media; phase exit tests eventually must exercise a
  real VM.

The host controls QEMU with QMP over a local Unix socket and uses QGA only for bootstrap-safe
operations. The steady-state control path is MCP client -> TypeScript MCP server -> host-only mTLS
channel -> Go guest service -> PowerShell/CDB/WinDbg tooling. Malware-analysis mode defaults to
isolated networking with no guest Internet access unless explicitly configured through a controlled
NAT or capture gateway.

## Repo Layout

```text
.
├── AGENTS.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── NOTES.md
├── PLAN.md
├── README.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts
├── .github/
│   └── workflows/
│       └── test.yml
├── docs/
│   ├── adr/
│   │   └── 0000-record-architecture-decisions.md
│   ├── protocol.md
│   ├── setup-windows.md
│   ├── threat-model.md
│   └── network-isolation.md
├── packages/
│   ├── cli/
│   │   └── src/
│   ├── core/
│   │   └── src/
│   └── mcp-server/
│       └── src/
├── guest/
│   ├── agent/
│   │   ├── cmd/crucible-agent/
│   │   ├── internal/
│   │   └── go.mod
│   └── provision/
│       ├── install-windbg.ps1
│       ├── install-agent.ps1
│       └── prepare-snapshot.ps1
├── schemas/
│   ├── config.schema.json
│   └── guest-api.schema.json
├── scripts/
│   ├── check-host.sh
│   ├── create-base-image.sh
│   └── teardown.sh
└── test/
    ├── fixtures/
    └── integration/
```

## MVP

The smallest real demo is: on a Linux host with KVM, run `crucible provision` to fetch or reuse
cached Windows and virtio installation media, create a qcow2 VM with virtio devices and isolated
host-only networking, install the Windows guest agent and WinDbg/CDB tooling, disable Windows
Defender and code-integrity protections appropriate for an isolated analysis VM, keep test signing
disabled by default unless a later explicit driver-lab override is requested, optionally apply
common malware-reversing environment camouflage settings, take a clean snapshot, restore that
snapshot, start `crucible mcp`, then use MCP tools to run `whoami` as the standard user, run an
elevated PowerShell command, upload a file, download a file, and execute a non-interactive debugger
command against a test process. Nothing in the MVP may require an open WinDbg GUI.

## Phased Checklist

### Phase 0 — Repository Bootstrap

**Goal:** Create a reviewed, testable project skeleton with the selected stack, contribution rules,
CI, and baseline documentation.

**Exit test:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` succeeds on
Linux without requiring KVM or Windows media.

**Deliverable checklist:**

- [x] Create TypeScript/pnpm workspace files: `package.json`, `pnpm-workspace.yaml`,
      `tsconfig.base.json`, `vitest.config.ts`.
- [x] Create minimal packages: `packages/core`, `packages/mcp-server`, `packages/cli` with buildable
      entry points.
- [x] Add quality tooling: ESLint, Prettier, TypeScript build scripts, Vitest scripts.
- [x] Add `.github/workflows/test.yml` with pull-request trigger, workflow_dispatch, concurrency
      cancellation, and stable `test` check.
- [x] Add `README.md`, `CONTRIBUTING.md`, `LICENSE`, `NOTES.md`, and ADR seed.
- [x] Add `.gitignore` for `references/`, node output, Go output, qcow2 images, ISO files, logs,
      snapshots, secrets, and OS junk.
- [x] Add `scripts/check-host.sh` stub that reports missing Linux/KVM/QEMU prerequisites without
      mutating the host.
- [x] Open Phase 1 issues for each worktree task after GitHub repo creation.

**Parallel-work split table:**

| Wave            | Worktree slug         | Depends on | Tasks                                                                                                    |
| --------------- | --------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| 1 (solo)        | bootstrap-skeleton    | —          | Workspace manifests, package skeletons, CI workflow, README/CONTRIBUTING/LICENSE/NOTES/ADR, `.gitignore` |
| 2 (parallel x3) | host-checks           | wave 1     | `scripts/check-host.sh`, prerequisite detection tests, README host prerequisites                         |
| 2 (parallel x3) | core-foundation       | wave 1     | `packages/core/src/{config,paths,process,errors}.ts` + tests                                             |
| 2 (parallel x3) | mcp-foundation        | wave 1     | MCP server entry point, tool registry skeleton, Zod schemas, smoke tests                                 |
| 3 (solo)        | bootstrap-integration | wave 2     | Wire CLI smoke commands, verify full local quality gate, tick Phase 0 items                              |

### Phase 1 — Host VM Lifecycle

**Goal:** Manage a Windows VM process on Linux with QEMU/KVM, virtio defaults, QMP control, and safe
local state tracking.

**Exit test:**
`pnpm crucible media:plan && pnpm crucible vm:create --dry-run && pnpm crucible vm:start --dry-run && pnpm test -- --run lifecycle`
shows cached media sources, the exact QEMU/QMP plan, and lifecycle tests pass without launching a
real VM.

**Deliverable checklist:**

- [x] Define `crucible.config.json` schema for VM name, CPU, memory, disk, default media cache,
      optional Windows ISO path or URL, optional virtio ISO path or URL, virtio device preferences,
      extra QEMU args, networking mode, QMP socket path, QGA socket path, and artifact directories.
- [x] Implement media cache planning for Windows 11 Enterprise Evaluation ISO and stable virtio-win
      ISO defaults, with Windows Server as an alternate profile, checksum metadata when available,
      manual-download instructions when automated downloads are blocked, and explicit operator
      override paths for custom ISOs.
- [x] Implement QEMU command builder with KVM acceleration, qcow2 disks, virtio-net, virtio-blk or
      virtio-scsi, virtio-serial, QMP socket, and QGA channel.
- [x] Implement QMP client with greeting negotiation, request IDs, timeout handling, event
      collection, and structured errors.
- [x] Implement lifecycle manager for start, stop, poweroff, kill-after-timeout, status, and
      cleanup.
- [x] Implement artifact manifest storage for disks, sockets, pid files, logs, snapshots, and
      generated credentials.
- [x] Add CLI commands for `vm:create`, `vm:start`, `vm:stop`, `vm:status`, and `vm:logs`.
- [x] Add host-only fake tests for QEMU command generation, QMP parsing, lifecycle state
      transitions, and timeout behavior.
- [x] Document required host packages and manual Windows ISO/virtio ISO inputs.

**Parallel-work split table:**

| Wave            | Worktree slug        | Depends on | Tasks                                                                                                                 |
| --------------- | -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| 1 (solo)        | lifecycle-interfaces | Phase 0    | Completed in PR #16: config schema, media cache contracts, state manifest interfaces, shared process runner contracts |
| 2 (parallel x3) | media-cache          | wave 1     | Completed in PR #25: default Windows desktop/virtio media sources, manual-download link output, cache planner, tests  |
| 2 (parallel x3) | qemu-command-builder | wave 1     | Completed in PR #29: QEMU argv generation, configurable virtio defaults, dry-run rendering, tests                     |
| 2 (parallel x3) | qmp-client           | wave 1     | Completed in PR #34: QMP socket client, negotiation, commands, events, timeout tests                                  |
| 3 (parallel x2) | lifecycle-manager    | wave 2     | Completed in PR #37: VM process manager, pid/log handling, stop/kill semantics, tests                                 |
| 4 (solo)        | lifecycle-cli-docs   | wave 3     | Completed in PR #40: CLI lifecycle commands, README/docs updates, dry-run exit test                                   |

Phase 1 exit test passed on 2026-05-27:
`pnpm crucible media:plan && pnpm crucible vm:create --dry-run && pnpm crucible vm:start --dry-run && pnpm test -- --run lifecycle`.

### Phase 2 — Contained Networking and Threat Model

**Goal:** Make the default malware-analysis network safe: host-only control plane, no accidental
Internet egress, explicit opt-in NAT/capture mode, and documented containment boundaries.

**Exit test:** `pnpm crucible net:plan --mode isolated && pnpm test -- --run network` prints
nftables/QEMU network actions with no guest egress route by default and all network tests pass.

**Deliverable checklist:**

- [x] Define network modes: `isolated`, `nat`, and `capture`, with `isolated` as default.
- [x] Implement network plan generator for QEMU user/slirp or tap-backed host-only network choices
      with explicit firewall rules.
- [x] Add nftables or iptables rule generation with dry-run and apply modes, bounded to
      project-specific chains.
- [x] Add host-only control address allocation and guest API port mapping rules.
- [x] Add teardown logic that removes only project-owned network rules and interfaces.
- [x] Add threat model documentation covering malware escape assumptions, host file exposure,
      credentials, snapshots, and Internet egress.
- [x] Add tests for default-deny egress, teardown idempotence, and no broad firewall deletion.
- [x] Add operator warnings for running samples and a safe default artifact directory outside shared
      home directories.

**Parallel-work split table:**

| Wave            | Worktree slug     | Depends on | Tasks                                                                                     |
| --------------- | ----------------- | ---------- | ----------------------------------------------------------------------------------------- |
| 1 (solo)        | network-model     | Phase 1    | Completed in PR #48: network mode schema, interface contracts, docs outline               |
| 2 (parallel x3) | firewall-planner  | wave 1     | Completed in PR #51: nftables/iptables plan generator, dry-run/apply models, tests        |
| 2 (parallel x3) | qemu-networking   | wave 1     | Completed in PR #49: QEMU network argv integration, control address allocation, tests     |
| 2 (parallel x3) | threat-model-docs | wave 1     | Completed in PR #50: `docs/threat-model.md`, `docs/network-isolation.md`, README warnings |
| 3 (solo)        | network-teardown  | wave 2     | Completed in PR #52: teardown command, idempotence tests, phase exit command              |

Phase 2 exit test passed on 2026-05-27:
`pnpm crucible net:plan --mode isolated && pnpm test -- --run network`.

### Phase 3 — Windows Guest Provisioning

**Goal:** Install required Windows-side dependencies, the guest control service, local accounts,
WinDbg/CDB tooling, and a clean baseline snapshot.

**Exit test:** On a configured real VM,
`pnpm crucible provision && pnpm crucible snapshot:create clean-base && pnpm crucible snapshot:restore clean-base && pnpm crucible guest:health`
returns healthy, reports WinDbg/CDB availability, reports Defender disabled, reports code-integrity
state recorded, and confirms test signing is disabled unless explicitly overridden.

**Deliverable checklist:**

- [x] Add provisioning scripts for QEMU guest agent readiness and bootstrap checks.
- [x] Add WinDbg installation script using `winget install Microsoft.WinDbg` when available and SDK
      Debugging Tools fallback when not.
- [x] Add OpenSSH enablement only as a bootstrap fallback, not as the steady-state control plane.
- [x] Add Windows Defender disablement, code-integrity policy changes, and test-signing checks for
      isolated analysis VMs with clear audit output.
- [x] Add optional malware-reversing environment profile flags for hostname, username, locale,
      screen size, sleep settings, Explorer visibility, and other common analysis-lab camouflage
      settings.
- [x] Add Windows local account setup for standard and admin execution contexts with generated
      credentials stored only in host project secrets.
- [x] Add guest agent installation script that registers the service, firewall rule limited to
      host-only control network, and mTLS certificate material.
- [x] Add readiness checks for CDB/WinDbg, symbol path configuration, PowerShell version, service
      status, admin/non-admin accounts, Defender state, code-integrity state, and test-signing
      state.
- [x] Add snapshot creation and restore commands using qcow2/QMP semantics with metadata in the
      artifact manifest.
- [x] Document Windows media, virtio driver, WinDbg installation caveats, and manual recovery steps.

**Parallel-work split table:**

| Wave            | Worktree slug                | Depends on | Tasks                                                                                                       |
| --------------- | ---------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| 1 (solo)        | provisioning-contracts       | Phase 2    | Completed in PR: provisioning state machine, script invocation contracts, secret storage contract           |
| 2 (parallel x3) | windbg-provisioning          | wave 1     | `install-windbg.ps1`, detection scripts, docs, tests with script lint/fakes                                 |
| 2 (parallel x3) | account-service-provisioning | wave 1     | Account setup, service install script, certificate staging, tests                                           |
| 2 (parallel x3) | analysis-vm-policy           | wave 1     | Completed in PR: Defender/code-integrity/test-signing policy script, malrev profile flags, readiness checks |
| 3 (parallel x2) | snapshot-manager             | wave 2     | Completed in PR: snapshot create/list/restore metadata and QMP/qcow2 integration tests                      |
| 3 (parallel x2) | provision-real-vm            | wave 2     | Completed in PR: end-to-end `crucible provision` command, guest health command, real-VM exit test docs      |

Phase 3 real target outcome on 2026-05-27: host-only CI-safe tests cover `crucible provision`,
`crucible snapshot:create clean-base`, `crucible snapshot:restore clean-base`, and
`crucible guest:health` through fake lifecycle/provisioning/snapshot adapters. The real-VM exit test
was not run in this worktree because no configured Windows VM/QGA/guest-service adapter was
available; Phase 3 remains incomplete until the real command sequence passes on target hardware.

### Phase 4 — Guest Control Service

**Goal:** Build the Go Windows service that provides authenticated command execution, file transfer,
health checks, and privilege-separated execution primitives.

**Exit test:** `go test ./...` in `guest/agent` passes on Linux, and on a provisioned VM
`pnpm crucible guest:exec whoami --as standard` and
`pnpm crucible guest:exec "whoami /groups" --as admin` both return expected structured results.

**Deliverable checklist:**

- [x] Create Go module and Windows service entry point with install/uninstall/run modes.
- [x] Implement mTLS HTTP API with pinned host CA, request IDs, audit logging, bounded body sizes,
      and timeouts.
- [x] Implement health endpoint reporting version, service identity, debugger tool paths, uptime,
      and execution context availability.
- [x] Implement command execution endpoint with working directory, environment allowlist, timeout,
      stdout/stderr capture, exit code, and max-output truncation.
- [x] Implement standard-user execution path.
- [x] Implement admin execution path without interactive UAC prompts, using a preconfigured
      service/helper boundary.
- [x] Implement file upload/download endpoints with staging directory constraints, hash reporting,
      max size limits, and path traversal protection.
- [x] Add host TypeScript client for the guest API and integration tests against a fake server.
- [x] Document guest service API and security model.

**Parallel-work split table:**

| Wave            | Worktree slug            | Depends on | Tasks                                                                   |
| --------------- | ------------------------ | ---------- | ----------------------------------------------------------------------- |
| 1 (solo)        | guest-api-contract       | Phase 3    | `schemas/guest-api.schema.json`, Go/TS shared API shapes, protocol docs |
| 2 (parallel x3) | go-service-mtls          | wave 1     | Windows service skeleton, mTLS server, health endpoint, tests           |
| 2 (parallel x3) | go-exec-contexts         | wave 1     | Standard/admin command execution, timeout/output model, tests           |
| 2 (parallel x3) | go-file-transfer         | wave 1     | Upload/download staging, hashing, path safety, tests                    |
| 3 (solo)        | guest-client-integration | wave 2     | TypeScript guest client, CLI wrappers, real-VM exec exit test           |

### Phase 5 — MCP Tool Surface

**Goal:** Expose stable MCP tools for VM lifecycle, provisioning, snapshot restore, command
execution, file transfer, and health inspection.

**Exit test:** `pnpm crucible mcp:smoke` starts `crucible mcp` over stdio, lists tools, calls
health/status tools against fakes, and against a provisioned local VM calls `guest_exec`,
`guest_exec_admin`, `upload_file`, `download_file`, `snapshot_restore`, and `debug_command`
successfully.

**Deliverable checklist:**

- [x] Register MCP tools for `host_check`, `vm_status`, `vm_start`, `vm_stop`, `snapshot_list`,
      `snapshot_restore`, `guest_health`.
- [x] Register MCP tools for `guest_exec`, `upload_file`, and `download_file`. `guest_exec_admin` is
      deferred until the guest agent grows the SCM impersonation path planned in Phase 4 follow-up.
- [x] Add structured Zod input/output schemas for every tool.
- [x] Add error mapping that distinguishes validation errors, host prerequisite errors, VM offline
      errors, guest service errors, timeout errors, and security policy denials.
- [x] Add MCP smoke-test harness that drives stdio without a human client.
- [ ] Add real-VM MCP integration tests gated by environment variables that verify every public MCP
      tool against a locally provisioned VM. _(deferred until the Phase 3 exit test passes against a
      real provisioned VM.)_
- [x] Add README MCP configuration snippets for opencode/Claude-style clients.
- [x] Add docs for safe malware-analysis workflow and snapshot restore before/after sample
      execution.
- [x] Add audit log locations to tool outputs where relevant.

**Parallel-work split table:**

| Wave            | Worktree slug          | Depends on | Tasks                                                         |
| --------------- | ---------------------- | ---------- | ------------------------------------------------------------- |
| 1 (solo)        | tool-contracts         | Phase 4    | Tool names, schemas, error taxonomy, docs outline             |
| 2 (parallel x3) | lifecycle-tools        | wave 1     | Host/VM/snapshot MCP tools + tests                            |
| 2 (parallel x3) | guest-tools            | wave 1     | Exec/file/health MCP tools + tests                            |
| 2 (parallel x3) | mcp-smoke-harness      | wave 1     | Stdio smoke client, fake adapters, CI-safe tests              |
| 3 (parallel x2) | mcp-realvm-integration | wave 2     | Environment-gated real-VM MCP tests covering all public tools |
| 3 (parallel x2) | mcp-docs-realvm        | wave 2     | README client config, real-VM smoke command, docs updates     |

### Phase 6 — Debugger Automation

**Goal:** Add non-interactive Windows debugging workflows around CDB/WinDbg tooling for process
launch/attach, command execution, dump capture, symbol setup, and vulnerability PoC iteration.

**Exit test:** On a provisioned VM,
`pnpm crucible debug:smoke --exe C:\\Windows\\System32\\notepad.exe` launches under CDB or
equivalent debugger automation, runs a command such as `~* k` or `lm`, captures output, terminates
cleanly, and the matching MCP debugger tool returns structured output.

**Deliverable checklist:**

- [x] Define debugger session model: launch, attach, command, break, detach/kill, collect dump, and
      close. _(Break is a normal cdb command; detach/kill is `debug_close` since each
      `debug_command` runs cdb in single-shot mode.)_
- [x] Implement guest-side debugger wrapper using command-line debugger tooling first, with GUI
      WinDbg explicitly not required.
- [x] Implement symbol path configuration and cache directory controls.
- [x] Add MCP tools for `debug_open`, `debug_command`, `debug_dump`, and `debug_close`.
      _(`debug_launch` / `debug_attach` collapse into `debug_open { mode: "launch" | "attach" }`
      since the session-spec discriminator is the only meaningful difference.)_
- [x] Add output truncation, transcript capture, and artifact metadata for debugger sessions.
- [x] Add tests with fake debugger executable and parser fixtures.
- [ ] Add real-VM smoke test against a benign Windows process. _(Deferred until the Phase 3 exit
      test passes; once a provisioned VM is reachable the manual recipe in `docs/debugger.md`
      becomes the automated coverage path.)_
- [x] Document PoC debugging workflow and known limitations for kernel debugging and TTD as
      extension points.

**Parallel-work split table:**

| Wave            | Worktree slug       | Depends on | Tasks                                                                   |
| --------------- | ------------------- | ---------- | ----------------------------------------------------------------------- |
| 1 (solo)        | debug-session-model | Phase 5    | Session interfaces, artifact metadata, command schema                   |
| 2 (parallel x3) | guest-debug-wrapper | wave 1     | Go debugger process wrapper, fake debugger tests, transcript capture    |
| 2 (parallel x3) | host-debug-client   | wave 1     | TypeScript debug client/session storage, parser fixtures, tests         |
| 2 (parallel x3) | debug-mcp-tools     | wave 1     | MCP debug tools and schemas, smoke harness tests                        |
| 3 (solo)        | debug-realvm-docs   | wave 2     | Real-VM smoke command, README/docs debugging workflow, limitation notes |

### Phase 7 — Hardening and Malware-Analysis Workflow

**Goal:** Make the tool safe and repeatable for malware-analysis use: pre/post snapshot policy,
audit trails, secret handling, network capture hooks, and operational guardrails.

**Exit test:** `pnpm crucible scenario:malware-dry-run` shows restore -> upload sample -> execute ->
collect artifacts -> restore flow without Internet egress, and on a real VM the same scenario works
with a benign test binary.

**Deliverable checklist:**

- [x] Add scenario runner that enforces restore-before-execution and restore-after-execution for
      malware mode.
- [x] Add policy checks that block host path sharing, broad download paths, and Internet egress
      unless explicitly overridden.
- [x] Add audit log aggregation for host commands, guest commands, file hashes, snapshots, and
      network mode changes.
- [ ] Add optional packet capture hook for capture mode with pcap artifact metadata. _(Deferred:
      Phase 2 added the network modes, but the pcap-capture hook + artifact wiring lands once
      capture-mode is actually exercised by a real provisioning run.)_
- [x] Add credential rotation core API for guest service certificates and local Windows accounts.
      _(CLI subcommand wiring lands when CLI surface for these helpers is added in a follow-up.)_
- [x] Add artifact export core API for logs, transcripts, dumps, pcaps, and hashes. _(CLI subcommand
      wiring lands with the same follow-up.)_
- [x] Add docs for malware-analysis safe operating procedure.
- [x] Add tests for policy denial paths, audit log integrity, and scenario ordering.

**Parallel-work split table:**

| Wave            | Worktree slug         | Depends on | Tasks                                                                  |
| --------------- | --------------------- | ---------- | ---------------------------------------------------------------------- |
| 1 (solo)        | policy-model          | Phase 6    | Malware-mode policy schema, scenario state machine, audit event schema |
| 2 (parallel x3) | scenario-runner       | wave 1     | Restore/upload/execute/collect/restore orchestration, tests            |
| 2 (parallel x3) | audit-artifacts       | wave 1     | Audit log aggregation, artifact export, hash metadata, tests           |
| 2 (parallel x3) | capture-credentials   | wave 1     | Packet capture hook, credential rotation commands, tests               |
| 3 (solo)        | malware-workflow-docs | wave 2     | SOP docs, dry-run command, benign real-VM scenario exit test           |

### Phase 8 — Release Readiness

**Goal:** Package the MCP server and guest agent, verify install/upgrade/teardown paths, and produce
a documented beta release.

**Exit test:** From a clean Linux checkout,
`pnpm install && pnpm build && pnpm crucible package && scripts/check-host.sh && scripts/teardown.sh --dry-run`
succeeds, and the real-VM MVP checklist passes from README instructions.

**Deliverable checklist:**

- [x] Add package/build outputs for TypeScript MCP server and CLI.
- [x] Add cross-compilation target for the Go Windows guest agent.
- [x] Add release artifact manifest with checksums.
- [x] Add install docs for Linux host, Windows media, virtio drivers, and MCP client configuration.
- [x] Add upgrade docs for guest agent and config migrations.
- [x] Add teardown docs and `scripts/teardown.sh` implementation for project-owned processes,
      sockets, firewall chains, and temporary artifacts.
- [x] Add final end-to-end README walkthrough using the MVP flow.
- [x] Add changelog entry for beta readiness.

**Parallel-work split table:**

| Wave            | Worktree slug         | Depends on | Tasks                                                                         |
| --------------- | --------------------- | ---------- | ----------------------------------------------------------------------------- |
| 1 (solo)        | release-contracts     | Phase 7    | Artifact manifest, versioning rules, packaging plan                           |
| 2 (parallel x3) | node-packaging        | wave 1     | TypeScript package build, bin entries, README install updates                 |
| 2 (parallel x3) | guest-packaging       | wave 1     | Go Windows cross-compile, checksums, service upgrade docs                     |
| 2 (parallel x3) | teardown-release-docs | wave 1     | Teardown script, release docs, changelog                                      |
| 3 (solo)        | beta-verification     | wave 2     | Clean-checkout verification, real-VM MVP walkthrough, final release checklist |

## Anticipated Risks

- **Performance / scale:** Windows install/provision and debugger sessions will be slow first;
  mitigate with qcow2 base images, clean snapshots, bounded command timeouts, and no phase
  completion until real restore flows work.
- **Performance / scale:** QMP/QGA socket operations can hang if QEMU wedges; mitigate with
  per-command deadlines, process supervision, and kill-after-timeout paths.
- **Cross-platform / portability:** Host control is intentionally Linux-only and KVM-dependent;
  mitigate by checking host prerequisites early and documenting that macOS/Windows hosts are out of
  scope.
- **Cross-platform / portability:** Windows SKUs differ in winget, OpenSSH, and WinDbg installation
  behavior; mitigate with detection-first provisioning and SDK Debugging Tools fallback.
- **Security:** Malware can attack the guest service and any exposed host channel; mitigate with
  host-only networking, mTLS, narrow firewall rules, bounded file staging, no shared folders by
  default, and snapshot restoration.
- **Security:** Admin execution is dangerous and may bypass UAC boundaries; mitigate with explicit
  `guest_exec_admin` tool separation, audit logging, non-interactive service-helper design, and
  policy denials in malware mode.
- **Security:** Host secrets and generated Windows credentials could leak into logs or Git; mitigate
  with `.gitignore`, redaction, secret file permissions, and no credential echo in tool results.
- **Security:** Supply chain risk exists in npm, Go modules, WinDbg installers, and Windows media;
  mitigate with pinned lockfiles, checksum manifests where feasible, official sources, and
  dependency review.
- **Security:** Disabling Defender and code-integrity protections makes the guest intentionally
  unsafe; mitigate by limiting those changes to isolated analysis VMs, recording policy state in
  health output, and restoring clean snapshots after use.
- **Licensing / attribution:** QEMU documentation is GPL-2.0 but only used as protocol
  documentation, not copied into code; mitigate by not adapting QEMU source/manual text and
  recording citations in docs where needed.
- **Licensing / attribution:** Existing WinDbg MCP repositories are researched but not cloned or
  adapted; mitigate with clean-room implementation and no `references/` code imports.
- **API / dependency churn:** The MCP TypeScript SDK main branch is transitioning toward v2 while
  npm stable is v1.29.0; mitigate by pinning stable v1-compatible package versions and recording an
  ADR before any v2 migration.
- **API / dependency churn:** QMP/QGA schemas evolve across QEMU versions; mitigate by conservative
  JSON parsing, feature detection, and tests against captured protocol fixtures.
- **Test fragility:** Real Windows VM tests are expensive, stateful, and can fail from
  installer/network variance; mitigate with fake unit tests for CI and explicit real-VM exit tests
  for phase boundaries.
- **Test fragility:** Default ISO download links and virtio mirrors may redirect, require
  registration, or be protected by anti-bot systems; mitigate with local cache reuse, custom
  ISO/virtio override paths, clear manual-download URLs in CLI output, and tests that can use
  preseeded media.
- **Test fragility:** Debugger output is textual and version-dependent; mitigate with structured
  wrapper metadata and parser fixtures that tolerate harmless output differences.
- **Cloud cost:** No cloud resources are in scope; N/A except GitHub Actions minutes, mitigated by
  PR concurrency cancellation and no real VM CI by default.
- **Data model lock-in:** Snapshot manifests and config schemas could become hard to migrate;
  mitigate with versioned JSON schemas and migration hooks before beta.
- **Concurrency / state:** Multiple MCP calls could race on the same VM, snapshot, or guest command
  channel; mitigate with per-VM locks, operation leases, idempotent teardown, and clear busy errors.
- **Concurrency / state:** Leaked QEMU processes, sockets, firewall rules, and helper services can
  persist after failures; mitigate with manifests, resource ownership tags, teardown dry-run/apply,
  and leak sweeps in tests.
- **Operational / lifecycle:** Windows provisioning can leave the VM half-configured; mitigate with
  resumable provisioning stages, health checks, and a documented manual recovery path.
- **Operational / lifecycle:** Updating the guest agent inside snapshots can drift from host
  expectations; mitigate with version handshake and upgrade command.
- **Abandonment risk:** If development pauses mid-phase, worktrees, generated images, and firewall
  rules may remain; mitigate with `scripts/teardown.sh --dry-run`, NOTES pause entries, and all
  artifacts under project-owned directories.

## Extension Points

- Kernel debugging via KDNET can attach to the Phase 6 debugger session model without changing MCP
  lifecycle tools.
- Time Travel Debugging can attach as a new debugger backend under the same `debug_*` tools once
  licensing and install behavior are understood.
- A capture gateway can extend Phase 2 `capture` networking without changing the guest API.
- YARA/Sigma/sample triage can attach to Phase 7 artifact export and audit logs.
- Multiple named VM profiles can extend the config schema after single-VM state locking is stable.
- Custom media profiles can extend the config schema for operator-selected Windows ISOs, virtio
  driver bundles, QEMU device models, and provisioning scripts without replacing the default
  cached-media path.
- Driver-development mode can explicitly enable test signing later, but malware-analysis mode keeps
  test signing disabled by default.
- A web dashboard can consume the same `packages/core` APIs without changing MCP tools.
- libvirt support can be added behind the lifecycle manager if direct QEMU process control becomes
  too brittle.

## Manual Download Links

`crucible media:plan` and `crucible provision` must print these links when automated media download
fails or when the operator asks for manual setup:

- Windows 11 Enterprise Evaluation page:
  `https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise`
- Windows 11 Enterprise Evaluation ISO direct Microsoft fwlink observed during bootstrap:
  `https://go.microsoft.com/fwlink/p/?linkid=2195682&clcid=0x409&culture=en-us&country=us`
- Windows Server 2025 Evaluation page for the alternate server profile:
  `https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2025`
- Windows Server 2025 Evaluation ISO direct Microsoft fwlink observed during bootstrap:
  `https://go.microsoft.com/fwlink/?linkid=2345730&clcid=0x409&culture=en-us&country=us`
- stable virtio-win ISO:
  `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso`
- latest virtio-win ISO:
  `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win.iso`
- latest virtio-win guest tools:
  `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win-guest-tools.exe`

The CLI must explain where to place manually downloaded files in the media cache and how to point
`crucible.config.json` at custom paths.

## Teardown

One-command project teardown will be:

```sh
scripts/teardown.sh --apply
```

The command must stop project-owned QEMU processes, remove project-owned sockets and pid files,
remove project-owned nftables/iptables chains and tap interfaces, clean temporary provisioning
artifacts, and print any qcow2 images or snapshots left intentionally for the operator to delete
manually. It must not delete Windows ISOs, virtio driver ISOs, or user-specified sample/artifact
directories unless a future explicit destructive flag is added.

Development worktrees live under `../crucible-wt/`; remove them with:

```sh
rm -rf ../crucible-wt/
```

No cloud resources are planned.

## License Choice

Chosen SPDX identifier: **MIT**.

Reasoning: planned runtime dependencies are permissive or Apache-compatible:
`@modelcontextprotocol/sdk` / MCP server packages are MIT or Apache-2.0-compatible depending on
package generation, Zod is MIT, TypeScript is Apache-2.0, Vitest/ESLint/Prettier/tsx are MIT, and
`golang.org/x/sys` is BSD-3-Clause with Go patent grant files. QEMU and WinDbg are external
tools/protocols installed by the operator or package managers and are not linked into this project.
Existing WinDbg MCP servers were researched for market gap only and are not cloned or adapted, so
their licenses do not drive this repo's license. MIT is the most permissive compatible default.

Dependency/license and health summary from research:

| Dependency or source                             | Role                                | SPDX                                                  | Canonicality and health                                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` / TypeScript MCP SDK | MCP server APIs                     | MIT / Apache-2.0-compatible upstream transition noted | First-party `modelcontextprotocol`; npm `1.29.0`, modified 2026-03-30; healthy. ⚠️ Upstream repo main is v2 pre-alpha, so pin stable APIs and avoid training-knowledge assumptions. |
| `zod`                                            | Tool/config schema validation       | MIT                                                   | First-party `colinhacks/zod`; npm `4.4.3`, modified 2026-05-04; healthy.                                                                                                            |
| `typescript`                                     | Type checking/build                 | Apache-2.0                                            | First-party Microsoft; npm `6.0.3`, modified 2026-04-16; healthy.                                                                                                                   |
| `vitest`                                         | Tests                               | MIT                                                   | First-party `vitest-dev`; npm `4.1.7`, modified 2026-05-20; healthy.                                                                                                                |
| `eslint`, `@eslint/js`                           | Lint                                | MIT                                                   | First-party ESLint; recent 2026 releases; healthy.                                                                                                                                  |
| `prettier`                                       | Format                              | MIT                                                   | First-party Prettier; npm `3.8.3`, modified 2026-04-15; healthy.                                                                                                                    |
| `tsx`                                            | Local TypeScript execution          | MIT                                                   | Third-party but actively maintained; npm `4.22.3`, modified 2026-05-19; healthy.                                                                                                    |
| `@types/node`                                    | Type declarations                   | MIT                                                   | DefinitelyTyped community-maintained; npm `25.9.1`, modified 2026-05-19; healthy and standard ecosystem choice.                                                                     |
| `golang.org/x/sys`                               | Windows service/syscall helpers     | BSD-3-Clause                                          | First-party Go team mirror; `v0.45.0`, 2026-05-21; healthy.                                                                                                                         |
| QEMU/QMP/QGA documentation                       | Protocol documentation only         | GPL-2.0 for manual                                    | External documentation/tool; no source/manual text adapted into code.                                                                                                               |
| Microsoft WinDbg/Debugging Tools docs            | Installation/debugger behavior docs | Microsoft docs terms                                  | External documentation/tool; installer and EULA remain operator responsibility.                                                                                                     |
| Existing WinDbg MCP repos found on GitHub        | Market research only                | Mixed/unchecked because not cloned or adapted         | Not dependencies. Found several active repos, but they do not cover full Linux-hosted VM lifecycle + secure guest service requirements.                                             |
