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
    /**
     * Optional pcap output path for capture mode. The host writes every
     * frame on the tap netdev here via QEMU `-object filter-dump`.
     * Ignored unless mode === "capture".
     */
    pcapPath: z.string().min(1).optional(),
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
  readonly missingResourceOk?: boolean;
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
  readonly pcapPath?: string;
};

export type NetworkTeardownPlan = {
  readonly owner: NetworkOwnerTag;
  readonly firewallCommandIds: readonly string[];
  readonly interfaceNames: readonly string[];
};

export type NetworkTeardownResource =
  | {
      readonly kind: "firewall";
      readonly ruleId: string;
      readonly owner: NetworkOwnerTag;
    }
  | {
      readonly kind: "interface";
      readonly name: string;
      readonly owner: NetworkOwnerTag;
    };

export type NetworkTeardownRefusal = {
  readonly resource: NetworkTeardownResource;
  readonly reason: string;
};

export type NetworkTeardownCommandPlan = {
  readonly id: string;
  readonly operation: FirewallOperationMode;
  readonly argv: readonly string[];
  readonly description: string;
  readonly missingResourceOk: true;
  readonly owner: NetworkOwnerTag;
  readonly resource: NetworkTeardownResource;
};

export type NetworkTeardownOutputModel = {
  readonly operation: FirewallOperationMode;
  readonly owner: NetworkOwnerTag;
  readonly commands: readonly NetworkTeardownCommandPlan[];
  readonly refused: readonly NetworkTeardownRefusal[];
  readonly warnings: readonly string[];
};

export type NetworkTeardownOptions = {
  readonly plan: NetworkPlan;
  readonly operation?: FirewallOperationMode;
  readonly discoveredResources?: readonly NetworkTeardownResource[];
};

export type NetworkPlan = {
  readonly mode: NetworkMode;
  readonly qemu: QemuNetworkPlan;
  readonly firewall: FirewallPlan;
  readonly teardown: NetworkTeardownPlan;
  readonly warnings: readonly string[];
};

export type NetworkRuntimeStatus = {
  readonly configuredMode: NetworkMode;
  readonly backend: QemuNetworkBackend;
  readonly guestAddress: string;
  readonly hostAddress: string;
  readonly controlPort: number;
  readonly guestEgress: "denied" | "allowed" | "captured";
  readonly liveSwitchSupported: boolean;
  readonly restartRequiredToChangeMode: boolean;
  readonly warnings: readonly string[];
};

export type NetworkModeChangePlan = {
  readonly currentMode: NetworkMode;
  readonly requestedMode: NetworkMode;
  readonly appliedLive: boolean;
  readonly restartRequired: boolean;
  readonly reason: string;
  readonly qemuArgsPreview: readonly string[];
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
    pcapPath: options.config.pcapPath,
  });
  const firewall = buildFirewallPlan(mode, owner, options.firewallBackend ?? "nftables");

  return {
    mode,
    qemu,
    firewall,
    teardown: {
      owner,
      firewallCommandIds: firewall.teardown.map((command) => command.ruleId),
      interfaceNames: qemu.backend === "tap" ? [`${netdevId}-tap`] : [],
    },
    warnings: buildNetworkWarnings(mode),
  };
}

export function buildNetworkRuntimeStatus(plan: NetworkPlan): NetworkRuntimeStatus {
  return {
    configuredMode: plan.mode,
    backend: plan.qemu.backend,
    guestAddress: plan.qemu.controlAddress.guestAddress,
    hostAddress: plan.qemu.controlAddress.hostAddress,
    controlPort: plan.qemu.controlAddress.guestApiPort,
    guestEgress:
      plan.mode === "isolated" ? "denied" : plan.mode === "capture" ? "captured" : "allowed",
    liveSwitchSupported: false,
    restartRequiredToChangeMode: true,
    warnings: plan.warnings,
  };
}

export function buildNetworkModeChangePlan(options: {
  readonly current: NetworkPlan;
  readonly requested: NetworkPlan;
}): NetworkModeChangePlan {
  if (options.current.mode === options.requested.mode) {
    return {
      currentMode: options.current.mode,
      requestedMode: options.requested.mode,
      appliedLive: true,
      restartRequired: false,
      reason: "network mode already active",
      qemuArgsPreview: options.requested.qemu.args,
    };
  }

  const sameBackend = options.current.qemu.backend === options.requested.qemu.backend;
  const liveSwitchSupported = sameBackend && options.current.qemu.backend === "tap";
  return {
    currentMode: options.current.mode,
    requestedMode: options.requested.mode,
    appliedLive: false,
    restartRequired: !liveSwitchSupported,
    reason: liveSwitchSupported
      ? "tap-backed mode changes can be applied by host firewall/tap operations"
      : "QEMU user-network restrict/capture backend changes require restarting the VM with new netdev args",
    qemuArgsPreview: options.requested.qemu.args,
  };
}

export function buildNetworkTeardownOutputModel(
  options: NetworkTeardownOptions,
): NetworkTeardownOutputModel {
  const operation = options.operation ?? "dry-run";
  const expectedResources = buildExpectedTeardownResources(options.plan);
  const resources = options.discoveredResources ?? expectedResources;
  const expectedResourceKeys = new Set(expectedResources.map(teardownResourceKey));
  const commands: NetworkTeardownCommandPlan[] = [];
  const refused: NetworkTeardownRefusal[] = [];

  for (const resource of resources) {
    const refusal = teardownResourceRefusal(resource, options.plan, expectedResourceKeys);

    if (refusal !== undefined) {
      refused.push({ resource, reason: refusal });
      continue;
    }

    commands.push(buildNetworkTeardownCommand(resource, options.plan, operation));
  }

  return {
    operation,
    owner: options.plan.teardown.owner,
    commands,
    refused,
    warnings: refused.length > 0 ? ["Skipped resources outside this teardown contract"] : [],
  };
}

function buildExpectedTeardownResources(plan: NetworkPlan): readonly NetworkTeardownResource[] {
  return [
    ...plan.teardown.firewallCommandIds.map((ruleId) => ({
      kind: "firewall" as const,
      ruleId,
      owner: plan.teardown.owner,
    })),
    ...plan.teardown.interfaceNames.map((name) => ({
      kind: "interface" as const,
      name,
      owner: plan.teardown.owner,
    })),
  ];
}

function teardownResourceRefusal(
  resource: NetworkTeardownResource,
  plan: NetworkPlan,
  expectedResourceKeys: ReadonlySet<string>,
): string | undefined {
  if (!sameNetworkOwner(resource.owner, plan.teardown.owner)) {
    return "owner tag does not match this network plan";
  }

  if (!expectedResourceKeys.has(teardownResourceKey(resource))) {
    return "resource is not listed in this network plan teardown contract";
  }

  if (resource.kind === "interface" && resource.name !== `${plan.teardown.owner.resourceId}-tap`) {
    return "interface name is broader than the project-owned tap name";
  }

  return undefined;
}

function sameNetworkOwner(left: NetworkOwnerTag, right: NetworkOwnerTag): boolean {
  return (
    left.project === right.project &&
    left.vmName === right.vmName &&
    left.resourceId === right.resourceId
  );
}

function teardownResourceKey(resource: NetworkTeardownResource): string {
  return resource.kind === "firewall"
    ? `firewall:${resource.owner.project}:${resource.owner.vmName}:${resource.owner.resourceId}:${resource.ruleId}`
    : `interface:${resource.owner.project}:${resource.owner.vmName}:${resource.owner.resourceId}:${resource.name}`;
}

function buildNetworkTeardownCommand(
  resource: NetworkTeardownResource,
  plan: NetworkPlan,
  operation: FirewallOperationMode,
): NetworkTeardownCommandPlan {
  if (resource.kind === "firewall") {
    const command = plan.firewall.teardown.find((entry) => entry.ruleId === resource.ruleId);

    if (command === undefined) {
      throw new CrucibleError(
        "STATE_INVALID",
        "Missing firewall teardown command for owned resource",
        {
          resource,
        },
      );
    }

    return {
      id: `${command.id}-${operation}`,
      operation,
      argv: operation === "dry-run" ? previewFirewallCommand(command.argv) : command.argv,
      description: command.description,
      missingResourceOk: true,
      owner: command.owner,
      resource,
    };
  }

  const argv = ["ip", "link", "delete", "dev", resource.name];

  return {
    id: `${resource.name}-interface-teardown-${operation}`,
    operation,
    argv: operation === "dry-run" ? previewFirewallCommand(argv) : argv,
    description: `Remove project-owned tap interface ${resource.name}`,
    missingResourceOk: true,
    owner: resource.owner,
    resource,
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
  /**
   * Optional pcap output path. Only honoured for capture mode — emits an
   * `-object filter-dump,...` so QEMU writes every frame seen on the tap
   * netdev to disk for later analysis. Ignored for `isolated` / `nat`.
   */
  readonly pcapPath?: string;
}): QemuNetworkPlan {
  const portForwards = buildQemuPortForwards(options.controlAddress);

  const args: string[] = [
    "-netdev",
    qemuNetdevValue(options.mode, options.netdevId, options.controlAddress, portForwards),
    "-device",
    `${options.networkDevice},netdev=${options.netdevId}`,
  ];
  const pcapPath =
    options.mode === "capture" && options.pcapPath !== undefined && options.pcapPath !== ""
      ? options.pcapPath
      : undefined;
  if (pcapPath !== undefined) {
    validateQemuSuboptionValue("pcapPath", pcapPath);
    args.push(
      "-object",
      `filter-dump,id=${options.netdevId}-pcap,netdev=${options.netdevId},file=${pcapPath}`,
    );
  }

  return {
    mode: options.mode,
    backend: options.mode === "capture" ? "tap" : "user",
    netdevId: options.netdevId,
    deviceModel: options.networkDevice,
    args,
    controlAddress: options.controlAddress,
    portForwards,
    owner: options.owner,
    pcapPath,
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
        missingResourceOk: true,
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
      missingResourceOk: true,
      owner: rule.owner,
    })),
    ...iptablesSetupTeardownCommands(owner).map((argv, index) => ({
      id: `${owner.resourceId}-setup-${index}-teardown`,
      ruleId: `${owner.resourceId}-setup-${index}`,
      operation: "apply" as const,
      argv,
      description: "Remove project-owned iptables setup",
      missingResourceOk: true,
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
