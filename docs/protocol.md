# Protocol Notes

## QMP

Crucible talks to QEMU over a local Unix QMP socket configured by `qmp.socketPath`. The client waits
for QEMU's greeting, validates the message shape, then sends `qmp_capabilities` before any lifecycle
command is allowed to run.

Every command carries a Crucible-generated request ID unless the caller supplies one. Request IDs
are single-use for the lifetime of a QMP connection. Responses must include the same ID so late,
missing, or unrelated responses fail closed instead of being matched to a future command. Commands
are serialized by the client, and QMP events received between sending a command and receiving its
response are collected and returned with that command result. Callers can also drain accumulated
events directly.

QMP parsing is intentionally conservative. The client rejects invalid JSON, non-object messages,
unknown top-level response fields, malformed greetings, malformed errors, and response IDs that are
not strings or numbers. Payloads inside documented QMP fields such as `return`, event `data`, and
version metadata remain opaque so newer QEMU versions can add command-specific fields without
breaking the host client.

The default QMP timeout is `5000` milliseconds. It applies to socket connection, greeting
negotiation, `qmp_capabilities`, and commands unless a call overrides `timeoutMs`. Timeouts surface
as structured `QMP_TIMEOUT` errors and remove the timed-out request from the pending table so a
delayed response cannot satisfy a later command.

## Crucible guest service (mTLS HTTP)

The Windows guest exposes an HTTPS service on the host-only control network (default
`192.0.2.2:8443`). All requests require:

- TLS 1.3 with a server certificate chained to the host CA.
- A client certificate chained to the same host CA; the agent rejects un-pinned or unrelated chains.
- Per-host CA, server cert, and client cert/key paths configured on both ends; certificates are
  issued by `crucible provision`.

Every HTTP response carries an `X-Request-Id` (echoed from the request or synthesized server-side).
Audit events are appended to a JSONL log (`--audit-log`, default stderr) capturing the request id,
client CN, method, path, and any action-specific detail.

### `GET /health`

Returns a JSON document describing the agent:

```json
{
  "status": "ok",
  "version": "<built version>",
  "hostName": "CRUCIBLE-WIN11",
  "startedAt": "2026-05-28T10:00:00Z",
  "uptimeSeconds": 1234,
  "goVersion": "go1.25.2",
  "windbgInstalled": true,
  "cdbPath": "C:\\Program Files\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
  "windbgPath": "C:\\Program Files\\Windows Kits\\10\\Debuggers\\x64\\windbg.exe"
}
```

### `POST /exec`

Bounded command execution under the agent's identity (LocalSystem when the agent runs as a Windows
service). Request body:

```json
{
  "executable": "C:\\Windows\\System32\\cmd.exe",
  "arguments": ["/c", "whoami /groups"],
  "workingDirectory": "C:\\\\ProgramData\\\\Crucible\\\\staging",
  "environment": { "FOO": "bar" },
  "timeoutMs": 60000
}
```

Limits: at most 64 arguments, `timeoutMs <= 1800000` (30 minutes), each of stdout/stderr capped at 4
MiB then `truncated: true`. The request body itself is bounded at `--max-request-bytes` (64 MiB
default) and exceeded payloads return HTTP 413.

`environment` entries are layered on top of the inherited Windows environment so PATH / SystemRoot
survive. Stdin and elevation switching are **not** implemented in this revision; both will be added
in a follow-up once standard / admin user impersonation is wired through the Windows service runner.

Response:

```json
{
  "exitCode": 0,
  "stdoutBase64": "...",
  "stderrBase64": "",
  "timedOut": false,
  "durationMs": 12,
  "truncated": false
}
```

Limits: at most 64 arguments, `timeoutMs <= 1800000` (30 minutes), each of stdout/stderr capped at 4
MiB then `truncated: true`. Response:

```json
{
  "exitCode": 0,
  "stdoutBase64": "...",
  "stderrBase64": "",
  "timedOut": false,
  "durationMs": 12,
  "truncated": false
}
```

### `POST /upload?path=<staging-relative>`

Body is the raw file contents. The target must resolve inside `--staging-dir`
(`C:\\ProgramData\\Crucible\\staging` by default); absolute paths and `..` traversal are rejected
with HTTP 400. The server caps the request body at `--max-request-bytes` (64 MiB default) and
replies with the resolved path, byte count, and SHA-256.

### `GET /download?path=<staging-relative>`

Streams the file as `application/octet-stream` with `X-Crucible-Size` and a chunked-trailer
`X-Crucible-Sha256`. Same path-safety rules as `/upload`.

### Threat model and limits

- The agent only binds the host-only address by default; the firewall rule added by
  `install-agent.ps1` constrains the inbound port to the host control address.
- Authentication is purely mTLS — the agent never reads passwords from the wire. Local Windows
  accounts created by `create-local-accounts.ps1` are used by the agent itself to switch user
  context for `elevation: standard` / `admin` exec, _not_ exposed to the network.
- All file operations are staging-relative, so a misbehaving caller cannot read or write arbitrary
  disk paths through the agent.
- Audit events are append-only JSONL and survive process restarts.
