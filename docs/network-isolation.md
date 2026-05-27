# Network Isolation

Crucible's network model starts with contracts rather than host mutation. The default mode is
`isolated`, and later Phase 2 work will turn these contracts into concrete firewall and QEMU setup
commands.

## Modes

- `isolated` omits a guest NIC from the QEMU plan and carries firewall intent to allow only the
  host-control path while denying guest egress.
- `nat` is an explicit opt-in mode for guest Internet egress through QEMU user networking.
- `capture` is an explicit opt-in mode for tap-backed traffic capture while retaining project-owned
  teardown tags.

## Contract Surfaces

- `NetworkPlan` combines the selected mode, QEMU network arguments, firewall intent, control address
  allocation, teardown tags, and operator warnings.
- `FirewallPlan` is dry-run-only in the model layer and records rule intent, target firewall
  backend, and owner tags without applying host rules.
- `QemuNetworkPlan` records whether QEMU should receive no network args, a user-mode netdev, or a
  tap-backed netdev.
- `ControlAddressAllocation` reserves the host-control address pair and guest API port used by later
  guest-service work.
- `NetworkTeardownPlan` lists only project-owned firewall rule IDs and interface names that teardown
  code may remove.

## Teardown Ownership

Every planned network resource carries a `NetworkOwnerTag` with `project`, `vmName`, and
`resourceId`. Teardown implementations must match these tags before deleting firewall rules or
interfaces and must not perform broad firewall table cleanup.

## Open Implementation Work

- Generate concrete nftables or iptables dry-run/apply plans from `FirewallPlan`.
- Wire host-only control address assignment into tap/user networking setup.
- Implement `crucible net:plan --mode isolated` output for the Phase 2 exit test.
- Add packet capture artifact metadata for `capture` mode.
