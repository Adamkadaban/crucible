# Protocol Notes

## QMP

Crucible talks to QEMU over a local Unix QMP socket configured by `qmp.socketPath`. The client waits
for QEMU's greeting, validates the message shape, then sends `qmp_capabilities` before any lifecycle
command is allowed to run.

Every command carries a Crucible-generated request ID unless the caller supplies one. Responses must
include the same ID so late, missing, or unrelated responses fail closed instead of being matched to
a future command. QMP events received while a command is pending are collected and returned with
that command result; callers can also drain accumulated events directly.

QMP parsing is intentionally conservative. The client rejects invalid JSON, non-object messages,
unknown top-level response fields, malformed greetings, malformed errors, and response IDs that are
not strings or numbers. Payloads inside documented QMP fields such as `return`, event `data`, and
version metadata remain opaque so newer QEMU versions can add command-specific fields without
breaking the host client.

The default QMP timeout is `5000` milliseconds. It applies to socket connection, greeting
negotiation, `qmp_capabilities`, and commands unless a call overrides `timeoutMs`. Timeouts surface
as structured `QMP_TIMEOUT` errors and remove the timed-out request from the pending table so a
delayed response cannot satisfy a later command.
