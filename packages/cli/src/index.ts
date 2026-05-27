#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
  buildNetworkPlan,
  buildNetworkTeardownOutputModel,
  buildMediaCachePlan,
  buildProvisioningPlan,
  buildQemuCommandPlan,
  FIREWALL_BACKENDS,
  getManualDownloadInstructions,
  loadCrucibleConfigFile,
  NETWORK_MODES,
  renderQemuCreateDryRun,
  renderQemuStartDryRun,
  SnapshotManager,
  type CrucibleConfig,
  type FirewallBackend,
  type FirewallCommandPlan,
  type FirewallOperationMode,
  type MediaCacheEntry,
  type MediaProfileName,
  type NetworkMode,
  type NetworkTeardownCommandPlan,
  type NetworkTeardownOutputModel,
  type SnapshotCreateResult,
  type SnapshotRecord,
  type SnapshotRestoreResult,
  type VmStatus,
  type VmStopResult,
  VmLifecycleManager,
} from "@crucible/core";
import { BOOTSTRAP_TOOLS, getMcpServerBanner } from "@crucible/mcp-server";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CliRuntime = {
  readonly config?: CrucibleConfig;
  readonly configPath?: string;
};

type MediaPlanArgs = {
  readonly profile: MediaProfileName;
  readonly includeManualInstructions: boolean;
};

type NetPlanArgs = {
  readonly mode: NetworkMode;
  readonly firewallBackend: FirewallBackend;
  readonly includeApply: boolean;
};

type NetTeardownArgs = {
  readonly mode: NetworkMode;
  readonly firewallBackend: FirewallBackend;
  readonly operation: FirewallOperationMode;
};

export async function runCrucibleCli(
  args: readonly string[],
  runtime: CliRuntime = {},
): Promise<CommandResult> {
  const [command, ...rest] = args;

  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      return { exitCode: 0, stdout: getHelpText(), stderr: "" };
    case "media:plan":
      return renderMediaPlanCommand(rest, runtime);
    case "net:plan":
      return renderNetPlanCommand(rest, runtime);
    case "net:teardown":
      return renderNetTeardownCommand(rest, runtime);
    case "vm:create":
      return runVmCreateCommand(rest, runtime);
    case "vm:start":
      return runVmStartCommand(rest, runtime);
    case "vm:stop":
      return runVmStopCommand(rest, runtime);
    case "vm:status":
      return runVmStatusCommand(rest, runtime);
    case "vm:logs":
      return runVmLogsCommand(rest, runtime);
    case "snapshot:create":
      return runSnapshotCreateCommand(rest, runtime);
    case "snapshot:list":
      return runSnapshotListCommand(rest, runtime);
    case "snapshot:restore":
      return runSnapshotRestoreCommand(rest, runtime);
    case "provision":
      return renderProvisionCommand(rest, runtime);
    case "mcp":
      return {
        exitCode: 0,
        stdout: [getMcpServerBanner(), "Bootstrap tools:", ...BOOTSTRAP_TOOLS.map(formatTool)].join(
          "\n",
        ),
        stderr: "",
      };
    default:
      return {
        exitCode: 2,
        stdout: "",
        stderr: `Unknown command: ${command}\n\n${getHelpText()}`,
      };
  }
}

function runVmCreateCommand(args: readonly string[], runtime: CliRuntime): CommandResult {
  if (args.length !== 1 || args[0] !== "--dry-run") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "vm:create currently supports --dry-run only.",
    };
  }

  const plan = buildQemuCommandPlan({ config: getRuntimeConfig(runtime) });
  return {
    exitCode: 0,
    stdout: ["VM create dry run:", renderQemuCreateDryRun(plan)].join("\n"),
    stderr: "",
  };
}

async function runVmStartCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  if (args.length === 1 && args[0] === "--dry-run") {
    const plan = buildQemuCommandPlan({ config: getRuntimeConfig(runtime) });
    return {
      exitCode: 0,
      stdout: ["VM start dry run:", renderQemuStartDryRun(plan)].join("\n"),
      stderr: "",
    };
  }

  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown vm:start option: ${args[0]}` };
  }

  const result = await getLifecycleManager(runtime).start();
  return {
    exitCode: 0,
    stdout: [`VM started: pid ${result.pid}`, renderVmStatus(result.status)].join("\n"),
    stderr: "",
  };
}

async function runVmStopCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  const manager = getLifecycleManager(runtime);
  let result: VmStopResult;
  let action = "stop";

  switch (args[0]) {
    case undefined:
      result = await manager.stop();
      break;
    case "--poweroff":
      action = "poweroff";
      result = await manager.poweroff();
      break;
    case "--kill":
      action = "kill";
      result = await manager.kill();
      break;
    default:
      return { exitCode: 2, stdout: "", stderr: `Unknown vm:stop option: ${args[0]}` };
  }

  if (args.length > 1) {
    return { exitCode: 2, stdout: "", stderr: `Unknown vm:stop option: ${args[1]}` };
  }

  return { exitCode: 0, stdout: renderVmStopResult(result, action), stderr: "" };
}

async function runVmStatusCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown vm:status option: ${args[0]}` };
  }

  return {
    exitCode: 0,
    stdout: renderVmStatus(await getLifecycleManager(runtime).status()),
    stderr: "",
  };
}

async function runVmLogsCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown vm:logs option: ${args[0]}` };
  }

  const paths = getLifecycleManager(runtime).paths;
  const [stdoutLog, stderrLog] = await Promise.all([
    readLog(paths.stdoutLog),
    readLog(paths.stderrLog),
  ]);

  return {
    exitCode: 0,
    stdout: [
      `stdout log: ${paths.stdoutLog}`,
      stdoutLog,
      "",
      `stderr log: ${paths.stderrLog}`,
      stderrLog,
    ].join("\n"),
    stderr: "",
  };
}

function getLifecycleManager(runtime: CliRuntime): VmLifecycleManager {
  return new VmLifecycleManager({ config: getRuntimeConfig(runtime) });
}

function getSnapshotManager(runtime: CliRuntime): SnapshotManager {
  return new SnapshotManager({ config: getRuntimeConfig(runtime) });
}

async function runSnapshotCreateCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  const parsed = parseSnapshotNameArgs(args, "snapshot:create");
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const result = await getSnapshotManager(runtime).create(parsed.name);
  return { exitCode: 0, stdout: renderSnapshotCreateResult(result), stderr: "" };
}

async function runSnapshotListCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown snapshot:list option: ${args[0]}` };
  }

  return {
    exitCode: 0,
    stdout: renderSnapshotList(await getSnapshotManager(runtime).list()),
    stderr: "",
  };
}

async function runSnapshotRestoreCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  const parsed = parseSnapshotNameArgs(args, "snapshot:restore");
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const result = await getSnapshotManager(runtime).restore(parsed.name);
  return { exitCode: 0, stdout: renderSnapshotRestoreResult(result), stderr: "" };
}

function renderProvisionCommand(args: readonly string[], runtime: CliRuntime): CommandResult {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown provision option: ${args[0]}` };
  }

  const config = getRuntimeConfig(runtime);
  const plan = buildProvisioningPlan({
    vmName: config.vm.name,
    secretsDirectory: config.artifacts.secretsDirectory,
    controlPort: config.network.controlPort,
    guestAddress: "192.0.2.2",
    analysisPolicy: config.analysisPolicy,
  });
  const policyStage = plan.stages.find((stage) => stage.id === "policy-configured");

  return {
    exitCode: 0,
    stdout: [
      "crucible provision is scaffolded.",
      "Provisioning plan includes analysis VM policy configuration and CI-safe readiness contracts.",
      `VM: ${plan.vmName}`,
      `Analysis policy script: ${policyStage?.script?.scriptPath ?? "missing"}`,
      `Analysis policy argv: ${policyStage?.script?.arguments.map(shellQuote).join(" ") ?? "missing"}`,
      "Audit checks: Defender disabled, code-integrity state recorded, test signing disabled, environment profile recorded.",
      "Real Windows VM execution is deferred to the Phase 3 provision-real-vm worktree.",
      getManualDownloadInstructions(),
    ].join("\n"),
    stderr: "",
  };
}

function getRuntimeConfig(runtime: CliRuntime): CrucibleConfig {
  if (runtime.config !== undefined) {
    return runtime.config;
  }

  return loadCrucibleConfigFile(runtime.configPath);
}

function renderVmStopResult(result: VmStopResult, action: string): string {
  return [
    `VM ${action} requested.`,
    `qmp command sent: ${result.qmpCommandSent ? "yes" : "no"}`,
    `signal sent: ${result.signalSent ?? "none"}`,
    `killed after timeout: ${result.killedAfterTimeout ? "yes" : "no"}`,
    renderVmStatus(result.status),
  ].join("\n");
}

function renderVmStatus(status: VmStatus): string {
  const lines = [
    `status: ${status.status}`,
    `pid: ${status.pid ?? "none"}`,
    `process alive: ${status.processAlive ? "yes" : "no"}`,
    `qmp available: ${status.qmpAvailable ? "yes" : "no"}`,
    `qmp status: ${status.qmpStatus ?? "unknown"}`,
    `state manifest: ${status.paths.stateManifest}`,
    `pid file: ${status.paths.pidFile}`,
    `stdout log: ${status.paths.stdoutLog}`,
    `stderr log: ${status.paths.stderrLog}`,
  ];

  if (status.warnings.length > 0) {
    lines.push("warnings:", ...status.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function renderSnapshotCreateResult(result: SnapshotCreateResult): string {
  return [
    `Snapshot created: ${result.snapshot.name}`,
    `clean: ${result.snapshot.clean ? "yes" : "no"}`,
    `mode: ${result.snapshot.mode ?? "unknown"}`,
    `base disk: ${result.snapshot.baseDiskPath}`,
    `artifact manifest path: ${result.snapshot.path}`,
    `qmp commands: ${result.qmpCommands.length > 0 ? result.qmpCommands.join(", ") : "none"}`,
    `qcow2 commands: ${result.qcow2Commands.length > 0 ? result.qcow2Commands.map(formatCommandPlan).join("; ") : "none"}`,
  ].join("\n");
}

function renderSnapshotRestoreResult(result: SnapshotRestoreResult): string {
  return [
    `Snapshot restored: ${result.snapshot.name}`,
    `restored at: ${result.restoredAt}`,
    `mode: ${result.snapshot.mode ?? "unknown"}`,
    `base disk: ${result.snapshot.baseDiskPath}`,
    `qmp commands: ${result.qmpCommands.length > 0 ? result.qmpCommands.join(", ") : "none"}`,
    `qcow2 commands: ${result.qcow2Commands.length > 0 ? result.qcow2Commands.map(formatCommandPlan).join("; ") : "none"}`,
  ].join("\n");
}

function renderSnapshotList(snapshots: readonly SnapshotRecord[]): string {
  if (snapshots.length === 0) {
    return "Snapshots: none";
  }

  return [
    "Snapshots:",
    ...snapshots.map(
      (snapshot) =>
        `- ${snapshot.name}: ${snapshot.clean ? "clean" : "dirty"}, ${snapshot.mode ?? "unknown"}, ${snapshot.baseDiskPath}`,
    ),
  ].join("\n");
}

async function readLog(filePath: string): Promise<string> {
  try {
    const contents = await readFile(filePath, "utf8");
    return contents.trimEnd().length > 0 ? contents.trimEnd() : "(empty)";
  } catch (error) {
    if (isMissingPathError(error)) {
      return "(missing)";
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function renderMediaPlanCommand(args: readonly string[], runtime: CliRuntime): CommandResult {
  const config = getRuntimeConfig(runtime);
  const parsed = parseMediaPlanArgs(args, config.media.profile);

  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  return { exitCode: 0, stdout: renderMediaPlan(parsed.args, config), stderr: "" };
}

function renderNetPlanCommand(args: readonly string[], runtime: CliRuntime): CommandResult {
  const config = getRuntimeConfig(runtime);
  const parsed = parseNetPlanArgs(args, config.network.mode);

  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const plan = buildNetworkPlan({
    config: { ...config.network, mode: parsed.args.mode },
    firewallBackend: parsed.args.firewallBackend,
    networkDevice: config.virtio.networkDevice,
    vmName: config.vm.name,
  });

  return { exitCode: 0, stdout: renderNetPlan(plan, parsed.args), stderr: "" };
}

function renderNetTeardownCommand(args: readonly string[], runtime: CliRuntime): CommandResult {
  const config = getRuntimeConfig(runtime);
  const parsed = parseNetTeardownArgs(args, config.network.mode);

  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const plan = buildNetworkPlan({
    config: { ...config.network, mode: parsed.args.mode },
    firewallBackend: parsed.args.firewallBackend,
    networkDevice: config.virtio.networkDevice,
    vmName: config.vm.name,
  });
  const model = buildNetworkTeardownOutputModel({
    operation: parsed.args.operation,
    plan,
  });

  return { exitCode: 0, stdout: renderNetTeardown(model), stderr: "" };
}

function renderNetPlan(plan: ReturnType<typeof buildNetworkPlan>, args: NetPlanArgs): string {
  const lines = [
    `Network mode: ${plan.mode}`,
    `QEMU backend: ${plan.qemu.backend}`,
    `Firewall backend: ${plan.firewall.backend}`,
    `Default operation: ${plan.firewall.defaultOperation}`,
    `Owner: ${plan.firewall.owner.project}/${plan.firewall.owner.vmName}/${plan.firewall.owner.resourceId}`,
    "",
    "QEMU network args:",
    plan.qemu.args.length > 0 ? formatCommand(plan.qemu.args) : "(none; no guest NIC egress path)",
    "",
    "Firewall dry run commands:",
    ...plan.firewall.dryRun.map(formatFirewallCommand),
  ];

  if (args.includeApply) {
    lines.push(
      "",
      "Firewall apply commands (not executed by net:plan):",
      ...plan.firewall.apply.map(formatFirewallCommand),
      "",
      "Firewall teardown commands (project-owned rules only):",
      ...plan.firewall.teardown.map(formatFirewallCommand),
    );
  } else {
    lines.push(
      "",
      "Apply commands are hidden by default; pass --apply to print them after dry-run commands.",
    );
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:", ...plan.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function renderNetTeardown(model: NetworkTeardownOutputModel): string {
  const lines = [
    `Network teardown ${model.operation}:`,
    `Owner: ${model.owner.project}/${model.owner.vmName}/${model.owner.resourceId}`,
    "Missing resources: ignored",
    "Refuses resources outside this owner and teardown contract.",
    "Phase 2 print-only: no privileged host changes are executed.",
    "",
    model.operation === "dry-run" ? "Dry-run commands:" : "Apply commands:",
    ...model.commands.map(formatNetworkTeardownCommand),
  ];

  if (model.refused.length > 0) {
    lines.push(
      "",
      "Refused resources:",
      ...model.refused.map(
        (refusal) => `- ${formatTeardownResource(refusal.resource)}: ${refusal.reason}`,
      ),
    );
  }

  if (model.warnings.length > 0) {
    lines.push("", "Warnings:", ...model.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatFirewallCommand(command: FirewallCommandPlan): string {
  return `- ${command.ruleId}: ${formatCommand(command.argv)}`;
}

function formatNetworkTeardownCommand(command: NetworkTeardownCommandPlan): string {
  return `- ${formatTeardownResource(command.resource)}: ${formatCommand(command.argv)}`;
}

function formatTeardownResource(resource: NetworkTeardownCommandPlan["resource"]): string {
  return resource.kind === "firewall"
    ? `firewall ${resource.ruleId}`
    : `interface ${resource.name}`;
}

function formatCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

function formatCommandPlan(command: {
  readonly executable: string;
  readonly args: readonly string[];
}): string {
  return formatCommand([command.executable, ...command.args]);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function renderMediaPlan(args: MediaPlanArgs, config: CrucibleConfig): string {
  const plan = buildMediaCachePlan({ ...config.media, profile: args.profile });
  const lines = [
    `Media profile: ${plan.profile}`,
    `Media cache: ${plan.cacheDirectory}`,
    "",
    "Planned media:",
    ...plan.entries.map(formatMediaEntry),
  ];

  if (args.includeManualInstructions) {
    lines.push("", getManualDownloadInstructions(plan.cacheDirectory, plan.manualDownloads));
  } else {
    lines.push(
      "",
      "Manual download instructions are hidden by default; pass --manual to include profile-specific links.",
    );
  }

  return lines.join("\n");
}

type MediaPlanArgsResult =
  | { readonly ok: true; readonly args: MediaPlanArgs }
  | { readonly ok: false; readonly message: string };

type NetPlanArgsResult =
  | { readonly ok: true; readonly args: NetPlanArgs }
  | { readonly ok: false; readonly message: string };

type NetTeardownArgsResult =
  | { readonly ok: true; readonly args: NetTeardownArgs }
  | { readonly ok: false; readonly message: string };

type SnapshotNameArgsResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string };

function parseSnapshotNameArgs(args: readonly string[], command: string): SnapshotNameArgsResult {
  if (args.length === 0) {
    return { ok: true, name: "clean-base" };
  }

  const [name] = args;
  if (args.length === 1 && name !== undefined && !name.startsWith("-")) {
    return { ok: true, name };
  }

  return { ok: false, message: `${command} accepts at most one snapshot name` };
}

function parseNetPlanArgs(args: readonly string[], defaultMode: NetworkMode): NetPlanArgsResult {
  let mode = defaultMode;
  let firewallBackend: FirewallBackend = "nftables";
  let includeApply = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--apply") {
      includeApply = true;
      continue;
    }

    if (arg === "--mode") {
      const value = args[index + 1];

      if (value === undefined) {
        return { ok: false, message: "Missing value for --mode" };
      }

      if (!isNetworkMode(value)) {
        return { ok: false, message: `Unknown network mode: ${value}` };
      }

      mode = value;
      index += 1;
      continue;
    }

    if (arg === "--backend") {
      const value = args[index + 1];

      if (value === undefined) {
        return { ok: false, message: "Missing value for --backend" };
      }

      if (!isFirewallBackend(value)) {
        return { ok: false, message: `Unknown firewall backend: ${value}` };
      }

      firewallBackend = value;
      index += 1;
      continue;
    }

    return { ok: false, message: `Unknown net:plan option: ${arg}` };
  }

  return { ok: true, args: { mode, firewallBackend, includeApply } };
}

function parseNetTeardownArgs(
  args: readonly string[],
  defaultMode: NetworkMode,
): NetTeardownArgsResult {
  let mode = defaultMode;
  let firewallBackend: FirewallBackend = "nftables";
  let operation: FirewallOperationMode = "dry-run";
  let sawDryRun = false;
  let sawApply = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      if (sawApply) {
        return { ok: false, message: "net:teardown accepts only one of --dry-run or --apply" };
      }

      sawDryRun = true;
      operation = "dry-run";
      continue;
    }

    if (arg === "--apply") {
      if (sawDryRun) {
        return { ok: false, message: "net:teardown accepts only one of --dry-run or --apply" };
      }

      sawApply = true;
      operation = "apply";
      continue;
    }

    if (arg === "--mode") {
      const value = args[index + 1];

      if (value === undefined) {
        return { ok: false, message: "Missing value for --mode" };
      }

      if (!isNetworkMode(value)) {
        return { ok: false, message: `Unknown network mode: ${value}` };
      }

      mode = value;
      index += 1;
      continue;
    }

    if (arg === "--backend") {
      const value = args[index + 1];

      if (value === undefined) {
        return { ok: false, message: "Missing value for --backend" };
      }

      if (!isFirewallBackend(value)) {
        return { ok: false, message: `Unknown firewall backend: ${value}` };
      }

      firewallBackend = value;
      index += 1;
      continue;
    }

    return { ok: false, message: `Unknown net:teardown option: ${arg}` };
  }

  return { ok: true, args: { mode, firewallBackend, operation } };
}

function isNetworkMode(value: string): value is NetworkMode {
  return NETWORK_MODES.includes(value as NetworkMode);
}

function isFirewallBackend(value: string): value is FirewallBackend {
  return FIREWALL_BACKENDS.includes(value as FirewallBackend);
}

function parseMediaPlanArgs(
  args: readonly string[],
  defaultProfile: MediaProfileName,
): MediaPlanArgsResult {
  let profile = defaultProfile;
  let includeManualInstructions = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--manual") {
      includeManualInstructions = true;
      continue;
    }

    if (arg === "--profile") {
      const value = args[index + 1];

      if (value === undefined) {
        return { ok: false, message: "Missing value for --profile" };
      }

      if (!isMediaProfileName(value)) {
        return { ok: false, message: `Unknown media profile: ${value}` };
      }

      profile = value;
      index += 1;
      continue;
    }

    return { ok: false, message: `Unknown media:plan option: ${arg}` };
  }

  return { ok: true, args: { profile, includeManualInstructions } };
}

function isMediaProfileName(value: string): value is MediaProfileName {
  return value === "windows11-enterprise-eval" || value === "windows-server-2025-eval";
}

function formatMediaEntry(entry: MediaCacheEntry): string {
  const source = entry.overridePath ?? entry.sourceUrl;
  const required = entry.required ? "required" : "optional";

  return `- ${entry.name} (${required}): ${source} -> ${entry.cachePath}`;
}

function formatTool(tool: (typeof BOOTSTRAP_TOOLS)[number]): string {
  return `- ${tool.name}: ${tool.description}`;
}

function getHelpText(): string {
  return [
    "crucible",
    "",
    "Usage:",
    "  crucible provision   Provision a Windows analysis VM (scaffolded)",
    "  crucible mcp         Start the MCP server (scaffolded)",
    "  crucible media:plan [--manual] [--profile windows11-enterprise-eval|windows-server-2025-eval]",
    "  crucible net:plan [--mode isolated|nat|capture] [--backend nftables|iptables] [--apply]",
    "  crucible net:teardown [--mode isolated|nat|capture] [--backend nftables|iptables] [--dry-run|--apply]",
    "  crucible vm:create --dry-run  Print the planned qcow2 creation and QEMU inputs",
    "  crucible vm:start [--dry-run] Print or run the planned QEMU argv and sockets",
    "  crucible vm:stop [--poweroff|--kill]",
    "  crucible vm:status",
    "  crucible vm:logs",
    "  crucible snapshot:create [name]  Create a QMP/qcow2 snapshot (default: clean-base)",
    "  crucible snapshot:list           List snapshots recorded in the artifact manifest",
    "  crucible snapshot:restore [name] Restore a QMP/qcow2 snapshot (default: clean-base)",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCrucibleCli(process.argv.slice(2)).catch((error: unknown) => ({
    exitCode: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));

  if (result.stdout.length > 0) {
    process.stdout.write(`${result.stdout}\n`);
  }

  if (result.stderr.length > 0) {
    process.stderr.write(`${result.stderr}\n`);
  }

  process.exitCode = result.exitCode;
}
