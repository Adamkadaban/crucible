# Network Isolation

Crucible's network model starts with contracts rather than host mutation. The default mode is
`isolated`, and later Phase 2 work will turn the firewall contracts into concrete host setup
commands.

## Modes

- `isolated` emits a restricted QEMU user-mode NIC for the host-control path and carries firewall
  intent to deny guest egress.
- `nat` is an explicit opt-in mode for guest Internet egress through unrestricted QEMU user
  networking.
- `capture` is an explicit opt-in mode for tap-backed traffic capture while retaining project-owned
  teardown tags.

## QEMU Integration

`isolated` is still the secure default. Its QEMU netdev uses `restrict=on`, which leaves the guest
without a general egress route while allowing the planned guest control service to be reached
through one TCP forward. The default control mapping is:

```text
192.0.2.1:8443 -> 192.0.2.2:8443
```

The port comes from `network.controlPort`. `nat` uses the same address allocation and port mapping
with `restrict=off`, making guest egress explicit in the dry-run command. `capture` uses a
project-owned tap name, `<netdev-id>-tap`, so later firewall and capture setup can bind traffic to a
specific Crucible VM.

## Contract Surfaces

- `NetworkPlan` combines the selected mode, QEMU network arguments, firewall intent, control address
  allocation, teardown tags, and operator warnings.
- `FirewallPlan` is dry-run-only in the model layer and records rule intent, target firewall
  backend, and owner tags without applying host rules.
- `QemuNetworkPlan` records whether QEMU should receive a restricted user-mode netdev, an
  unrestricted user-mode netdev, or a tap-backed netdev.
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
- Implement `crucible net:plan --mode isolated` output for the Phase 2 exit test.
- Add packet capture artifact metadata for `capture` mode.
