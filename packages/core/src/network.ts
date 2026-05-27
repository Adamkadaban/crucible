import { z } from "zod";

import { CrucibleError } from "./errors.js";

export const NETWORK_MODES = ["isolated", "nat", "capture"] as const;
export const FIREWALL_BACKENDS = ["nftables", "iptables"] as const;
export const FIREWALL_OPERATION_MODES = ["dry-run", "apply"] as const;

export type NetworkMode = (typeof NETWORK_MODES)[number];
export type FirewallBackend = (typeof FIREWALL_BACKENDS)[number];
export type FirewallOperationMode = (typeof FIREWALL_OPERATION_MODES)[number];

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

export type FirewallCommandPlan = {
  readonly id: string;
  readonly ruleId: string;
  readonly operation: FirewallOperationMode;
  readonly argv: readonly string[];
  readonly description: string;
  readonly owner: NetworkOwnerTag;
};

export type FirewallPlan = {
  readonly mode: NetworkMode;
  readonly backend: FirewallBackend;
  readonly defaultOperation: "dry-run";
  readonly rules: readonly FirewallRulePlan[];
  readonly dryRun: readonly FirewallCommandPlan[];
  readonly apply: readonly FirewallCommandPlan[];
  readonly teardown: readonly FirewallCommandPlan[];
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
  readonly firewallBackend?: FirewallBackend;
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
  const firewall = buildFirewallPlan(mode, owner, options.firewallBackend ?? "nftables");

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

function buildFirewallPlan(
  mode: NetworkMode,
  owner: NetworkOwnerTag,
  backend: FirewallBackend,
): FirewallPlan {
  const rules = firewallRuleIntents(mode).map((intent) => ({
    id: `${owner.resourceId}-${intent}`,
    intent,
    action: "add" as const,
    table: backend,
    description: firewallRuleDescription(intent),
    owner,
  }));

  return {
    mode,
    backend,
    defaultOperation: "dry-run",
    rules,
    dryRun: [
      ...buildFirewallSetupCommandPlans(backend, owner, "dry-run"),
      ...rules.map((rule) => buildFirewallCommandPlan(rule, "dry-run")),
    ],
    apply: [
      ...buildFirewallSetupCommandPlans(backend, owner, "apply"),
      ...rules.map((rule) => buildFirewallCommandPlan(rule, "apply")),
    ],
    teardown: buildFirewallTeardownCommandPlans(backend, owner, rules),
    owner,
  };
}

function buildFirewallSetupCommandPlans(
  backend: FirewallBackend,
  owner: NetworkOwnerTag,
  operation: FirewallOperationMode,
): readonly FirewallCommandPlan[] {
  const commands =
    backend === "nftables" ? nftablesSetupCommands(owner) : iptablesSetupCommands(owner);

  return commands.map((argv, index) => ({
    id: `${owner.resourceId}-setup-${index}-${operation}`,
    ruleId: `${owner.resourceId}-setup-${index}`,
    operation,
    argv: operation === "dry-run" ? previewFirewallCommand(argv) : argv,
    description: `${operation === "dry-run" ? "Validate" : "Apply"}: project-owned firewall setup`,
    owner,
  }));
}

function buildFirewallCommandPlan(
  rule: FirewallRulePlan,
  operation: FirewallOperationMode,
): FirewallCommandPlan {
  const argv = rule.table === "nftables" ? nftablesRuleCommand(rule) : iptablesRuleCommand(rule);

  return {
    id: `${rule.id}-${operation}`,
    ruleId: rule.id,
    operation,
    argv: operation === "dry-run" ? previewFirewallCommand(argv) : argv,
    description: `${operation === "dry-run" ? "Validate" : "Apply"}: ${rule.description}`,
    owner: rule.owner,
  };
}

function previewFirewallCommand(argv: readonly string[]): readonly string[] {
  return ["printf", "%s\\n", argv.map(commandArgument).join(" ")];
}

function commandArgument(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function buildFirewallTeardownCommandPlans(
  backend: FirewallBackend,
  owner: NetworkOwnerTag,
  rules: readonly FirewallRulePlan[],
): readonly FirewallCommandPlan[] {
  if (backend === "nftables") {
    return [
      {
        id: `${owner.resourceId}-table-teardown`,
        ruleId: `${owner.resourceId}-table`,
        operation: "apply",
        argv: nftablesTeardownCommand(owner),
        description: "Remove project-owned nftables table and rules",
        owner,
      },
    ];
  }

  return [
    ...rules.map((rule) => ({
      id: `${rule.id}-teardown`,
      ruleId: rule.id,
      operation: "apply" as const,
      argv: iptablesTeardownCommand(rule),
      description: `Remove project-owned rule: ${rule.description}`,
      owner: rule.owner,
    })),
    ...iptablesSetupTeardownCommands(owner).map((argv, index) => ({
      id: `${owner.resourceId}-setup-${index}-teardown`,
      ruleId: `${owner.resourceId}-setup-${index}`,
      operation: "apply" as const,
      argv,
      description: "Remove project-owned iptables setup",
      owner,
    })),
  ];
}

function nftablesSetupCommands(owner: NetworkOwnerTag): readonly (readonly string[])[] {
  return [
    ["nft", "add", "table", "inet", nftablesTable(owner)],
    [
      "nft",
      "add",
      "chain",
      "inet",
      nftablesTable(owner),
      nftablesChain(owner),
      "{",
      "type",
      "filter",
      "hook",
      "forward",
      "priority",
      "0",
      ";",
      "policy",
      "accept",
      ";",
      "}",
    ],
  ];
}

function iptablesSetupCommands(owner: NetworkOwnerTag): readonly (readonly string[])[] {
  return [
    ["iptables", "-N", iptablesChain(owner)],
    [
      "iptables",
      "-A",
      "FORWARD",
      "-m",
      "comment",
      "--comment",
      `crucible:${owner.vmName}:${owner.resourceId}:jump`,
      "-j",
      iptablesChain(owner),
    ],
  ];
}

function iptablesSetupTeardownCommands(owner: NetworkOwnerTag): readonly (readonly string[])[] {
  return [
    [
      "iptables",
      "-D",
      "FORWARD",
      "-m",
      "comment",
      "--comment",
      `crucible:${owner.vmName}:${owner.resourceId}:jump`,
      "-j",
      iptablesChain(owner),
    ],
    ["iptables", "-X", iptablesChain(owner)],
  ];
}

function nftablesRuleCommand(rule: FirewallRulePlan): readonly string[] {
  const chain = nftablesChain(rule.owner);
  const comment = firewallRuleComment(rule);
  const expression = nftablesRuleExpression(rule.intent);

  return [
    "nft",
    "add",
    "rule",
    "inet",
    nftablesTable(rule.owner),
    chain,
    ...expression,
    "comment",
    comment,
  ];
}

function nftablesTeardownCommand(owner: NetworkOwnerTag): readonly string[] {
  return ["nft", "delete", "table", "inet", nftablesTable(owner)];
}

function iptablesRuleCommand(rule: FirewallRulePlan): readonly string[] {
  return [
    "iptables",
    "-A",
    iptablesChain(rule.owner),
    ...iptablesRuleExpression(rule.intent),
    "-m",
    "comment",
    "--comment",
    firewallRuleComment(rule),
  ];
}

function iptablesTeardownCommand(rule: FirewallRulePlan): readonly string[] {
  return [
    "iptables",
    "-D",
    iptablesChain(rule.owner),
    ...iptablesRuleExpression(rule.intent),
    "-m",
    "comment",
    "--comment",
    firewallRuleComment(rule),
  ];
}

function nftablesTable(owner: NetworkOwnerTag): string {
  return `crucible_${owner.resourceId.replaceAll("-", "_")}`;
}

function nftablesChain(owner: NetworkOwnerTag): string {
  return `crucible_${owner.resourceId.replaceAll("-", "_")}_forward`;
}

function iptablesChain(owner: NetworkOwnerTag): string {
  return `CRUCIBLE-${owner.resourceId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "-")}`;
}

function firewallRuleComment(rule: FirewallRulePlan): string {
  return `crucible:${rule.owner.vmName}:${rule.owner.resourceId}:${rule.intent}`;
}

function nftablesRuleExpression(intent: FirewallRuleIntent): readonly string[] {
  switch (intent) {
    case "allow-host-control":
      return ["ip", "saddr", "192.0.2.1", "ip", "daddr", "192.0.2.2", "accept"];
    case "allow-nat-egress":
      return ["ip", "saddr", "192.0.2.2", "accept"];
    case "capture-guest-traffic":
      return ["ip", "saddr", "192.0.2.2", "counter", "accept"];
    case "deny-guest-egress":
      return ["ip", "saddr", "192.0.2.2", "drop"];
  }
}

function iptablesRuleExpression(intent: FirewallRuleIntent): readonly string[] {
  switch (intent) {
    case "allow-host-control":
      return ["-s", "192.0.2.1", "-d", "192.0.2.2", "-j", "ACCEPT"];
    case "allow-nat-egress":
      return ["-s", "192.0.2.2", "-j", "ACCEPT"];
    case "capture-guest-traffic":
      return ["-s", "192.0.2.2", "-j", "ACCEPT"];
    case "deny-guest-egress":
      return ["-s", "192.0.2.2", "-j", "DROP"];
  }
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
