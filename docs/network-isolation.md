# Network Isolation

Crucible's malware-analysis default is no guest Internet egress. The network model currently defines
the QEMU and firewall contracts that later Phase 2 work applies to the host. Until apply-mode
network setup lands, use dry-run output to verify that the selected mode matches the analysis risk.

## Network Modes

- `isolated` is the default. It plans QEMU backend `none`, emits no `-netdev` or network `-device`
  arguments, allows only the host-control intent, and records `deny-guest-egress` firewall intent.
- `nat` is explicit opt-in guest Internet egress. It plans QEMU backend `user` with
  `-netdev user,id=<netdevId>` and `virtio-net-pci`, and records `allow-nat-egress` firewall intent.
- `capture` is explicit opt-in tap-backed capture. It plans QEMU backend `tap` with
  `ifname=<netdevId>-tap`, `script=no`, `downscript=no`, and records `capture-guest-traffic`
  firewall intent.

## Configuration

The config schema accepts only these network fields:

```json
{
  "network": {
    "mode": "isolated",
    "controlPort": 8443
  }
}
```

`network.mode` must be `isolated`, `nat`, or `capture`. If omitted, it defaults to `isolated`.
`network.controlPort` is the guest API port reserved for the host-only control plane and defaults to
`8443`.

## Contract Surfaces

- `NetworkPlan` combines the selected mode, QEMU network arguments, firewall intent, control address
  allocation, teardown tags, and operator warnings.
- `QemuNetworkPlan` records whether QEMU receives no network args, a user-mode netdev, or a
  tap-backed netdev. The default `isolated` plan has `backend: "none"` and `args: []`.
- `FirewallPlan` is dry-run-only in the current model layer and records nftables rule intent, owner
  tags, and whether each rule would be added or removed. It does not mutate the host yet.
- `ControlAddressAllocation` reserves `192.0.2.1/30` for the host, `192.0.2.2/30` for the guest, and
  the configured guest API port for later guest-service work.
- `NetworkTeardownPlan` lists only project-owned firewall rule IDs and interface names that teardown
  code may remove.

## Firewall Intent

The network model records intent rather than applying broad host firewall changes:

| Mode       | Rule intents                                  | Internet egress   |
| ---------- | --------------------------------------------- | ----------------- |
| `isolated` | `allow-host-control`, `deny-guest-egress`     | No                |
| `nat`      | `allow-host-control`, `allow-nat-egress`      | Yes               |
| `capture`  | `allow-host-control`, `capture-guest-traffic` | Capture path only |

`nat` plans include the warning
`nat mode grants guest Internet egress and is not the malware-analysis default`. `capture` plans
include the warning `capture mode must keep packet captures outside repo-controlled paths`.

## Teardown Ownership

Every planned network resource carries a `NetworkOwnerTag` with `project: "crucible"`, `vmName`, and
`resourceId`. The default `resourceId` is derived from the VM name, for example
`crucible-analysis-one-net0`. Teardown implementations must match these tags before deleting
firewall rules or interfaces and must not perform broad firewall table cleanup.

In `isolated` and `nat` modes, the current teardown interface list is empty because no project-owned
tap interface is planned. In `capture` mode, teardown may remove only `<netdevId>-tap` for the
matching owner tag.

## Operator Guidance

- Use `isolated` for malware samples unless a specific analysis objective requires egress.
- Review `vm:start --dry-run` before launch. In isolated mode, the QEMU argv should not contain
  `-netdev` or a network `-device`.
- Do not add `vm.extraQemuArgs` that create bridge, socket, VNC-over-network, host filesystem, or
  unrestricted network devices unless the host is dedicated to that risk.
- Keep packet captures, dumps, and downloaded guest artifacts under artifact directories, not in Git
  or synced folders.
- Treat host firewall apply mode as privileged host mutation once it lands. It must remain bounded
  to project-owned rules and interfaces.

## Open Implementation Work

- Generate concrete nftables or iptables dry-run/apply plans from `FirewallPlan`.
- Wire host-only control address assignment into tap/user networking setup.
- Implement `crucible net:plan --mode isolated` output for the Phase 2 exit test.
- Add packet capture artifact metadata for `capture` mode.
