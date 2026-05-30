# Debugger automation (Phase 6)

Crucible exposes a tight wrapper around the Windows command-line debugger (`cdb.exe`) so the host
can drive triage from MCP tools without having to shell-script the guest manually. Every session is
host-side metadata; the guest runs one `cdb.exe -c "..."` invocation per `debug_command` call and
the host appends each invocation to the session transcript.

## Session lifecycle

1. `debug_open` — register a session. `mode: "launch"` spawns a new target executable;
   `mode: "attach"` attaches to an existing pid. Set `arch: "x86"` for 32-bit/WOW64 targets or
   `arch: "x64"` for native 64-bit targets; omitted defaults to x64. A `symbolPath`
   (`srv*<cache>*https://msdl.microsoft.com/download/symbols`) may be provided per session. No
   `cdb.exe` invocation happens at this step; the session is purely host-side state.
2. `debug_command` — execute one or more cdb commands inside the session. Commands are joined with
   `; ` and terminated with `q` so `cdb.exe` exits afterwards. Output is captured as base64
   (stdout/stderr) along with exit code, duration, and a `truncated` flag inherited from the bounded
   buffer.
3. `debug_dump` — `command(['.dump /ma <path>'])` shorthand. Pass `minidump: true` for a smaller
   triage dump.
4. `debug_close` — drop the session and discard its transcript.

The first three tools return a uniform `DebuggerCommandResult` envelope:

```json
{
  "command": "!analyze -v",
  "cdbArgs": ["-c", "!analyze -v; q", "-p", "1234"],
  "stdoutBase64": "...",
  "stderrBase64": "",
  "exitCode": 0,
  "timedOut": false,
  "truncated": false,
  "durationMs": 412
}
```

## Symbol path & cache

The provisioning stage `configure-policy.ps1` writes
`_NT_SYMBOL_PATH=srv*C:\Symbols*https://msdl.microsoft.com/download/symbols` into the machine
environment, and `install-windbg.ps1` ensures `C:\Symbols` exists. Sessions that want a custom cache
override `symbolPath` when opening. The guest agent's `/health` payload reports the discovered `cdb`
and `windbg` paths so the MCP server can confirm the toolchain is present before opening a session.

## Limits & known gaps

- **No interactive stdin.** Every `debug_command` runs as a fresh `cdb.exe` invocation; long-lived
  sessions, single-step debugging, and breakpoints that span commands require a future change to the
  guest agent (out-of-scope for the current phase).
- **No kernel debugging.** This wrapper targets user-mode triage of Windows processes. KD over named
  pipe / TTD recording is deferred.
- **Output bounded at 4 MiB per stream**, matching the guest agent's `/exec` cap. Large
  `!analyze -v` traces may be `truncated: true`.
- **Transcript capped at 200 entries per session.** When the cap is reached, the _oldest_ entries
  are dropped (FIFO) so the latest invocations stay available and host memory stays bounded.

## Smoke test

A real-VM smoke test against `notepad.exe` runs automatically when the environment is wired to a
live guest agent:

```sh
export CRUCIBLE_GUEST_BASE_URL=https://127.0.0.1:8443
export CRUCIBLE_GUEST_CA_PATH=artifacts/secrets/<vm>/mtls/ca.cert.pem
export CRUCIBLE_GUEST_CERT_PATH=artifacts/secrets/<vm>/mtls/host-client.cert.pem
export CRUCIBLE_GUEST_KEY_PATH=artifacts/secrets/<vm>/mtls/host-client.key.pem
pnpm test packages/core/src/debugger.live.test.ts
```

The test spawns a fresh `notepad.exe` via `/exec`, opens an attach session, runs `lm`, and verifies
the loaded-modules output mentions notepad. The test is skipped (not run) when those env vars are
unset, so CI stays hermetic.

Manual MCP recipe (for ad-hoc triage):

```sh
crucible mcp --stdio
# then in another shell (with mTLS env vars set):
mcp-cli call debug_open --json '{"mode":"launch","executable":"notepad.exe"}'
mcp-cli call debug_command --json '{"sessionId":"<id>","commands":["lm"]}'
mcp-cli call debug_close --json '{"sessionId":"<id>"}'
```

Automated coverage lives in `packages/core/src/debugger.test.ts` (cdb argv shapes, transcript
accounting, dump shortcut, oversize rejection) and `packages/mcp-server/src/index.test.ts` (MCP
envelope shape).
