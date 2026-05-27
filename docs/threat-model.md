# Threat Model

Crucible assumes the Windows guest may execute hostile code. The host-side design therefore defaults
to narrow control paths, no shared folders, and no accidental guest Internet egress.

## Current Scope

- Host control runs on Linux and manages QEMU/KVM through local sockets and process state.
- The Windows guest is untrusted once samples or exploit proofs of concept run.
- Project artifacts such as disks, snapshots, logs, packet captures, and crash dumps remain outside
  source control.

## Network Boundaries

- `isolated` mode is the default malware-analysis posture, uses a restricted QEMU user-mode NIC for
  the control channel only, and carries a deny-egress firewall intent.
- `nat` mode is operator opt-in because it uses unrestricted QEMU user networking and grants guest
  Internet egress.
- `capture` mode is operator opt-in and must store packet captures as artifacts, not source files.
- The guest control channel is modeled as host-only and bound to an explicit guest API port, mapped
  by default from host loopback `127.0.0.1:8443` to guest address `192.0.2.2:8443`.

## Host Exposure

- Host shared folders are out of scope for the safe default.
- File movement should use audited upload/download flows once the guest service exists.
- Teardown code may remove only resources tagged as Crucible-owned for the specific VM.

## Credentials

- Generated guest credentials and service certificates must stay under configured secret paths.
- Logs and dry-run output must not echo credential values.
- Later guest-service work must authenticate host control traffic with mTLS.

## Snapshots

- Malware-analysis workflows should restore a clean snapshot before and after executing a sample.
- Snapshot and disk artifacts are intentionally not deleted by routine lifecycle cleanup.

## Open Updates

- Document concrete nftables or iptables rules after the firewall planner lands.
- Document guest-service authentication and file staging constraints after Phase 4 contracts land.
- Document operator warnings and safe artifact directory policy as Phase 2 continues.
