import { z } from "zod";

import { CrucibleError } from "./errors.js";

export const NETWORK_MODES = ["isolated", "nat", "capture"] as const;

export type NetworkMode = (typeof NETWORK_MODES)[number];

export const networkModeSchema = z.enum(NETWORK_MODES);

export const networkConfigSchema = z
  .object({
    mode: networkModeSchema.default("isolated"),
    controlPort: z.number().int().min(1).max(65535).default(8443),
  })
  .strict();

export type NetworkConfig = z.output<typeof networkConfigSchema>;
export type NetworkConfigInput = z.input<typeof networkConfigSchema>;

export type NetworkOwnerTag = {
  readonly project: "crucible";
  readonly vmName: string;
  readonly resourceId: string;
};

export type ControlAddressAllocation = {
  readonly hostAddress: string;
  readonly guestAddress: string;
  readonly prefixLength: number;
  readonly guestApiPort: number;
};

export type QemuNetworkPortForward = {
  readonly protocol: "tcp";
  readonly hostListenAddress: string;
  readonly hostPort: number;
  readonly guestAddress: string;
  readonly guestPort: number;
};

export type FirewallRuleIntent =
  | "allow-host-control"
  | "deny-guest-egress"
  | "allow-nat-egress"
  | "capture-guest-traffic";

export type FirewallRulePlan = {
  readonly id: string;
  readonly intent: FirewallRuleIntent;
  readonly action: "add" | "remove";
  readonly table: "nftables" | "iptables";
  readonly description: string;
  readonly owner: NetworkOwnerTag;
};

export type FirewallPlan = {
  readonly mode: NetworkMode;
  readonly dryRunOnly: boolean;
  readonly rules: readonly FirewallRulePlan[];
  readonly owner: NetworkOwnerTag;
};

export type QemuNetworkBackend = "none" | "tap" | "user";

export type QemuNetworkPlan = {
  readonly mode: NetworkMode;
  readonly backend: QemuNetworkBackend;
  readonly netdevId?: string;
  readonly deviceModel?: "virtio-net-pci";
  readonly args: readonly string[];
  readonly controlAddress: ControlAddressAllocation;
  readonly portForwards: readonly QemuNetworkPortForward[];
  readonly owner: NetworkOwnerTag;
};

export type NetworkTeardownPlan = {
  readonly owner: NetworkOwnerTag;
  readonly firewallRuleIds: readonly string[];
  readonly interfaceNames: readonly string[];
};

export type NetworkPlan = {
  readonly mode: NetworkMode;
  readonly qemu: QemuNetworkPlan;
  readonly firewall: FirewallPlan;
  readonly teardown: NetworkTeardownPlan;
  readonly warnings: readonly string[];
};

export type NetworkPlanOptions = {
  readonly config: NetworkConfig;
  readonly vmName: string;
  readonly networkDevice?: "virtio-net-pci";
  readonly netdevId?: string;
};

export function parseNetworkConfig(input: unknown): NetworkConfig {
  return networkConfigSchema.parse(input);
}

export function buildNetworkPlan(options: NetworkPlanOptions): NetworkPlan {
  const netdevId = options.netdevId ?? defaultNetdevId(options.vmName);
  validateQemuSuboptionValue("netdevId", netdevId);
  const owner = buildNetworkOwnerTag(options.vmName, netdevId);
  const controlAddress = buildControlAddressAllocation(options.config.controlPort);
  const mode = options.config.mode;
  const qemu = buildQemuNetworkPlan({
    controlAddress,
    mode,
    netdevId,
    networkDevice: options.networkDevice ?? "virtio-net-pci",
    owner,
  });
  const firewall = buildFirewallPlan(mode, owner);

  return {
    mode,
    qemu,
    firewall,
    teardown: {
      owner,
      firewallRuleIds: firewall.rules.map((rule) => rule.id),
      interfaceNames: qemu.backend === "tap" ? [`${netdevId}-tap`] : [],
    },
    warnings: buildNetworkWarnings(mode),
  };
}

function defaultNetdevId(vmName: string): string {
  const suffix = vmName
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");

  if (suffix.length === 0) {
    return "crucible-vm-net0";
  }

  return `${suffix.startsWith("crucible-") ? suffix : `crucible-${suffix}`}-net0`;
}

function validateQemuSuboptionValue(name: string, value: string): void {
  if (/[,\\]/.test(value)) {
    throw new CrucibleError(
      "CONFIG_INVALID",
      `${name} cannot contain ',' or '\\' because QEMU suboptions would misparse it`,
      { name, value },
    );
  }
}

function buildNetworkOwnerTag(vmName: string, resourceId: string): NetworkOwnerTag {
  return {
    project: "crucible",
    vmName,
    resourceId,
  };
}

function buildControlAddressAllocation(guestApiPort: number): ControlAddressAllocation {
  return {
    hostAddress: "192.0.2.1",
    guestAddress: "192.0.2.2",
    prefixLength: 30,
    guestApiPort,
  };
}

function buildQemuNetworkPlan(options: {
  readonly controlAddress: ControlAddressAllocation;
  readonly mode: NetworkMode;
  readonly netdevId: string;
  readonly networkDevice: "virtio-net-pci";
  readonly owner: NetworkOwnerTag;
}): QemuNetworkPlan {
  const portForwards = buildQemuPortForwards(options.controlAddress);

  return {
    mode: options.mode,
    backend: options.mode === "capture" ? "tap" : "user",
    netdevId: options.netdevId,
    deviceModel: options.networkDevice,
    args: [
      "-netdev",
      qemuNetdevValue(options.mode, options.netdevId, options.controlAddress, portForwards),
      "-device",
      `${options.networkDevice},netdev=${options.netdevId}`,
    ],
    controlAddress: options.controlAddress,
    portForwards,
    owner: options.owner,
  };
}

function buildQemuPortForwards(
  controlAddress: ControlAddressAllocation,
): readonly QemuNetworkPortForward[] {
  return [
    {
      protocol: "tcp",
      hostListenAddress: "127.0.0.1",
      hostPort: controlAddress.guestApiPort,
      guestAddress: controlAddress.guestAddress,
      guestPort: controlAddress.guestApiPort,
    },
  ];
}

function qemuNetdevValue(
  mode: NetworkMode,
  netdevId: string,
  controlAddress: ControlAddressAllocation,
  portForwards: readonly QemuNetworkPortForward[],
): string {
  if (mode === "capture") {
    return `tap,id=${netdevId},ifname=${netdevId}-tap,script=no,downscript=no`;
  }

  const restrict = mode === "isolated" ? "on" : "off";
  return [
    "user",
    `id=${netdevId}`,
    `restrict=${restrict}`,
    `net=${qemuUserNetworkCidr(controlAddress)}`,
    `host=${controlAddress.hostAddress}`,
    `dhcpstart=${controlAddress.guestAddress}`,
    ...portForwards.map(formatQemuHostForward),
  ].join(",");
}

function qemuUserNetworkCidr(controlAddress: ControlAddressAllocation): string {
  const networkAddress = controlAddress.hostAddress.replace(/\.\d+$/, ".0");
  return `${networkAddress}/${controlAddress.prefixLength}`;
}

function formatQemuHostForward(forward: QemuNetworkPortForward): string {
  return `hostfwd=${forward.protocol}:${forward.hostListenAddress}:${forward.hostPort}-${forward.guestAddress}:${forward.guestPort}`;
}

function buildFirewallPlan(mode: NetworkMode, owner: NetworkOwnerTag): FirewallPlan {
  return {
    mode,
    dryRunOnly: true,
    rules: firewallRuleIntents(mode).map((intent) => ({
      id: `${owner.resourceId}-${intent}`,
      intent,
      action: "add",
      table: "nftables",
      description: firewallRuleDescription(intent),
      owner,
    })),
    owner,
  };
}

function firewallRuleIntents(mode: NetworkMode): readonly FirewallRuleIntent[] {
  if (mode === "nat") {
    return ["allow-host-control", "allow-nat-egress"];
  }

  if (mode === "capture") {
    return ["allow-host-control", "capture-guest-traffic"];
  }

  return ["allow-host-control", "deny-guest-egress"];
}

function firewallRuleDescription(intent: FirewallRuleIntent): string {
  switch (intent) {
    case "allow-host-control":
      return "Allow the host-only guest control channel.";
    case "allow-nat-egress":
      return "Allow explicitly selected NAT egress for the guest.";
    case "capture-guest-traffic":
      return "Route guest traffic through a capture-owned interface.";
    case "deny-guest-egress":
      return "Deny guest Internet egress by default.";
  }
}

function buildNetworkWarnings(mode: NetworkMode): readonly string[] {
  if (mode === "nat") {
    return ["nat mode grants guest Internet egress and is not the malware-analysis default"];
  }

  if (mode === "capture") {
    return ["capture mode must keep packet captures outside repo-controlled paths"];
  }

  return [];
}
