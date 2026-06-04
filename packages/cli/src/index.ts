#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, openSync, realpathSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat as fsStat,
  writeFile,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";

import {
  buildNetworkPlan,
  buildNetworkModeChangePlan,
  buildNetworkRuntimeStatus,
  buildNetworkTeardownOutputModel,
  buildGuestHealthReport,
  buildMediaCachePlan,
  buildQemuCommandPlan,
  buildProvisioningSecretStorageContract,
  CrucibleError,
  CRUCIBLE_VERSION,
  DebuggerSessionManager,
  describeCommand,
  FIREWALL_BACKENDS,
  getCrucibleConfigPath,
  getDefaultCrucibleConfigPath,
  getManualDownloadInstructions,
  loadCrucibleConfigFile,
  NETWORK_MODES,
  normalizeSnapshotName,
  prepareRealFirstBootProvisioning,
  QgaClient,
  QgaProvisioningExecutor,
  runScenario,
  type GuestAgentExecResult,
  type ProcessCommand,
  type ProcessResult,
  type ProcessRunner,
  renderQemuCreateDryRun,
  renderQemuStartDryRun,
  runProvisioningCommand,
  runHostCheck,
  SnapshotManager,
  type CrucibleConfig,
  type FirewallBackend,
  type FirewallCommandPlan,
  type FirewallOperationMode,
  type GuestAgentHealth,
  type MediaCacheEntry,
  type MediaProfileName,
  type NetworkMode,
  type NetworkTeardownCommandPlan,
  type NetworkTeardownOutputModel,
  type GuestHealthReport,
  type ProvisioningCommandResult,
  type ProvisioningExecutor,
  PROVISIONING_STAGE_IDS,
  type ProvisioningStageContract,
  type SnapshotCreateResult,
  type SnapshotRecord,
  type SnapshotRestoreResult,
  type VmStatus,
  type VmStopResult,
  VmLifecycleManager,
  QmpClient,
} from "@crucible/core";
import { spawn } from "node:child_process";
import {
  BOOTSTRAP_TOOLS,
  buildGuestAgentClientFromFiles,
  cacheGuestClientFactory,
  getMcpServerBanner,
  runStdioMcpServer,
} from "@crucible/mcp-server";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CommandDefinition = {
  readonly canonical: string;
  readonly preferred: string;
  readonly group?: string;
  readonly summary: string;
  readonly usage: readonly string[];
  readonly examples?: readonly string[];
  readonly aliases?: readonly string[];
};

type CommandGroupDefinition = {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
};

type ParsedCliInvocation =
  | { readonly kind: "command"; readonly command: string; readonly rest: readonly string[] }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "unknown-help"; readonly command: string }
  | { readonly kind: "unknown"; readonly command: string };

type CliGuestHealthClient = {
  readonly health: () => Promise<GuestAgentHealth>;
  readonly exec: (request: {
    readonly executable: string;
    readonly arguments?: readonly string[];
    readonly timeoutMs?: number;
    readonly as?: "service" | "standard" | "admin";
  }) => Promise<GuestAgentExecResult>;
  readonly close: () => Promise<void>;
};

type GuestPolicyHealth = {
  readonly cdbPath: string | null;
  readonly windbgPath: string | null;
  readonly kdPath?: string | null;
  readonly kdnetPath?: string | null;
  readonly gflagsPath?: string | null;
  readonly symbolPath: string | null;
  readonly symbolCachePath?: string | null;
  readonly symbolCacheWritable?: boolean;
  readonly sysinternals?: Readonly<Record<string, string | null>>;
  readonly crucibleAdminPresent: boolean;
  readonly crucibleUserPresent: boolean;
  readonly adminUsername?: string;
  readonly standardUsername?: string;
  readonly qemuAgentStatus: string;
  readonly crucibleAgentStatus: string;
  readonly defenderRealTimeProtectionEnabled: boolean | null;
  readonly codeIntegrityStateRecorded: boolean;
  readonly codeIntegrityEnforcementDisabled: boolean;
  readonly hypervisorEnforcedCodeIntegrityDisabled: boolean;
  readonly codeIntegrityBootOptions: readonly string[];
  readonly testSigningEnabled: boolean | null;
  readonly healthy: boolean;
};

type CliRuntime = {
  readonly config?: CrucibleConfig;
  readonly configPath?: string;
  readonly lifecycleManager?: CliLifecycleManager;
  readonly finalLifecycleManager?: CliLifecycleManager;
  readonly provisioningExecutor?: ProvisioningExecutor;
  readonly snapshotManager?: CliSnapshotManager;
  readonly guestClientFactory?: () => Promise<CliGuestHealthClient>;
  readonly processRunner?: ProcessRunner;
  readonly vmViewBridgeStarter?: VmViewBridgeStarter;
  readonly qmpClientFactory?: () => CliQmpSession;
  readonly skipBootKeyNudge?: boolean;
  readonly progress?: ProvisionProgressReporter;
  readonly stdinText?: string;
};

type VmViewBridgeStarter = (
  bridgeCommand: readonly string[],
  host: string,
  port: number,
) => Promise<
  | { readonly ok: true; readonly bridge: { readonly stop: () => void } }
  | { readonly ok: false; readonly error: string }
>;

type VmViewArgs = {
  readonly dryRun: boolean;
  readonly viewer: "remote-viewer" | "vncviewer";
  readonly host: string;
  readonly display: number;
};

type VmViewArgsResult =
  | { readonly ok: true; readonly args: VmViewArgs }
  | { readonly ok: false; readonly message: string };

type ProvisionProgressReporter = {
  readonly start: () => void;
  readonly stageStarted: (stage: ProvisioningStageContract) => void;
  readonly stageCompleted: (stage: ProvisioningStageContract) => void;
  readonly finish: (status: "complete" | "blocked" | "failed") => void;
};

type CliLifecycleManager = Pick<
  VmLifecycleManager,
  "paths" | "start" | "stop" | "poweroff" | "kill" | "status"
>;

type CliSnapshotManager = Pick<SnapshotManager, "create" | "list" | "restore">;

type MediaPlanArgs = {
  readonly profile: MediaProfileName;
  readonly includeManualInstructions: boolean;
};

type FetchToolsArgs = {
  readonly force: boolean;
};

type ConfigInitArgs = {
  readonly outputPath: string;
  readonly force: boolean;
};

type ConfigInitArgsResult =
  | { readonly ok: true; readonly args: ConfigInitArgs }
  | { readonly ok: false; readonly message: string };

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

type GuestExecArgs = {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly as: "service" | "standard" | "admin";
};

type SetupTarget = "host" | "opencode" | "claude" | "codex" | "copilot" | "all";

type SetupArgs = {
  readonly target: SetupTarget;
  readonly printOnly: boolean;
  readonly yes: boolean;
};

type SetupArgsResult =
  | { readonly ok: true; readonly args: SetupArgs }
  | { readonly ok: false; readonly message: string };

type UpdateArgs = {
  readonly dryRun: boolean;
  readonly yes: boolean;
};

type UpdateArgsResult =
  | { readonly ok: true; readonly args: UpdateArgs }
  | { readonly ok: false; readonly message: string };

type JsonObject = { [key: string]: unknown };
type QmpMouseButton = "left" | "middle" | "right";
type CliQmpSession = Pick<QmpClient, "connect" | "execute" | "close">;

const QEMU_TEXT_KEY_MAP: Readonly<Record<string, string>> = {
  " ": "spc",
  "\n": "ret",
  "\r": "ret",
  "\t": "tab",
  ".": "dot",
  ",": "comma",
  "/": "slash",
  "\\": "backslash",
  "-": "minus",
  "=": "equal",
  ";": "semicolon",
  ":": "shift-semicolon",
  "'": "apostrophe",
  '"': "shift-apostrophe",
  "[": "bracket_left",
  "]": "bracket_right",
  "{": "shift-bracket_left",
  "}": "shift-bracket_right",
  "`": "grave_accent",
  "~": "shift-grave_accent",
  _: "shift-minus",
  "+": "shift-equal",
  "|": "shift-backslash",
  "<": "shift-comma",
  ">": "shift-dot",
  "?": "shift-slash",
  "!": "shift-1",
  "@": "shift-2",
  "#": "shift-3",
  $: "shift-4",
  "%": "shift-5",
  "^": "shift-6",
  "&": "shift-7",
  "*": "shift-8",
  "(": "shift-9",
  ")": "shift-0",
  "0": "0",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
};
const QEMU_KEY_ALIASES: Readonly<Record<string, string>> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  win: "meta_l",
  windows: "meta_l",
  cmd: "meta_l",
  meta: "meta_l",
  enter: "ret",
  return: "ret",
  escape: "esc",
  esc: "esc",
  space: "spc",
  tab: "tab",
  delete: "delete",
  del: "delete",
  backspace: "backspace",
};

export function qemuKeyForTextInput(key: string): string {
  const mapped = QEMU_TEXT_KEY_MAP[key];
  if (mapped !== undefined) return mapped;
  if (/^[a-z]$/.test(key)) return key;
  if (/^[A-Z]$/.test(key)) return `shift-${key.toLowerCase()}`;
  throw new CrucibleError(
    "CONFIG_INVALID",
    `unsupported key for VM text input: ${JSON.stringify(key)}`,
  );
}

export function normalizeVmTextInput(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export async function runCrucibleCli(
  args: readonly string[],
  runtime: CliRuntime = {},
): Promise<CommandResult> {
  const parsed = parseCliInvocation(args);
  if (parsed.kind === "help") {
    return { exitCode: 0, stdout: parsed.text, stderr: "" };
  }
  if (parsed.kind === "unknown-help") {
    return { exitCode: 2, stdout: "", stderr: renderUnknownCommand(parsed.command) };
  }
  if (parsed.kind === "unknown") {
    return { exitCode: 2, stdout: "", stderr: renderUnknownCommand(parsed.command) };
  }
  const { command, rest } = parsed;

  switch (command) {
    case "media:plan":
      return renderMediaPlanCommand(rest, runtime);
    case "media:fetch-tools":
      return fetchToolsCommand(rest, runtime);
    case "config:init":
      return initConfigCommand(rest);
    case "doctor":
      return doctorCommand(rest);
    case "setup":
      return setupCommand(rest, runtime);
    case "version":
      return versionCommand(rest);
    case "update":
      return updateCommand(rest, runtime);
    case "net:plan":
      return renderNetPlanCommand(rest, runtime);
    case "net:status":
      return renderNetStatusCommand(rest, runtime);
    case "net:set":
      return renderNetSetCommand(rest, runtime);
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
    case "vm:credentials":
      return runVmCredentialsCommand(rest, runtime);
    case "vm:paste":
      return runVmPasteCommand(rest, runtime);
    case "vm:view":
      return runVmViewCommand(rest, runtime);
    case "vm:logs":
      return runVmLogsCommand(rest, runtime);
    case "snapshot:create":
      return runSnapshotCreateCommand(rest, runtime);
    case "snapshot:list":
      return runSnapshotListCommand(rest, runtime);
    case "snapshot:restore":
      return runSnapshotRestoreCommand(rest, runtime);
    case "provision":
      return runProvisionCommand(rest, runtime);
    case "guest:health":
      return runGuestHealthCommand(rest, runtime);
    case "guest:exec":
      return runGuestExecCommand(rest, runtime);
    case "debug:smoke":
      return runDebugSmokeCommand(rest, runtime);
    case "scenario:malware-dry-run":
      return runMalwareDryRunCommand(rest);
    case "package":
      return runPackageCommand(rest, runtime);
    case "mcp": {
      const wantsStdio = rest.includes("--stdio");
      if (wantsStdio) {
        const config = getRuntimeConfig(runtime);
        const guestClientFactory = buildEnvGuestClientFactory();
        await runStdioMcpServer({
          config,
          configPath: getCrucibleConfigPath(runtime.configPath),
          guestClientFactory,
          vmAdapter: buildMcpVmAdapter(config),
          snapshotAdapter: buildMcpSnapshotAdapter(config),
        });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: [
          getMcpServerBanner(),
          "Bootstrap tools:",
          ...BOOTSTRAP_TOOLS.map(formatTool),
          "",
          "Run `crucible mcp --stdio` to expose the tools over stdio for an MCP client.",
          "Set CRUCIBLE_GUEST_BASE_URL + CRUCIBLE_GUEST_CA_PATH +",
          "CRUCIBLE_GUEST_CERT_PATH + CRUCIBLE_GUEST_KEY_PATH to wire the guest tools",
          "to a live Crucible guest agent.",
        ].join("\n"),
        stderr: "",
      };
    }
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
  if (![undefined, "--poweroff", "--kill"].includes(args[0])) {
    return { exitCode: 2, stdout: "", stderr: `Unknown vm:stop option: ${args[0]}` };
  }

  if (args.length > 1) {
    return { exitCode: 2, stdout: "", stderr: `Unknown vm:stop option: ${args[1]}` };
  }

  const manager = getLifecycleManager(runtime);

  switch (args[0]) {
    case undefined: {
      const result = await manager.stop();
      return { exitCode: 0, stdout: renderVmStopResult(result, "stop"), stderr: "" };
    }
    case "--poweroff": {
      const result = await manager.poweroff();
      return { exitCode: 0, stdout: renderVmStopResult(result, "poweroff"), stderr: "" };
    }
    case "--kill": {
      const result = await manager.kill();
      return { exitCode: 0, stdout: renderVmStopResult(result, "kill"), stderr: "" };
    }
  }

  return { exitCode: 2, stdout: "", stderr: `Unknown vm:stop option: ${String(args[0])}` };
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

async function runVmPasteCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  let text: string | undefined;
  let fromStdin = false;
  let delayMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--text": {
        const value = args[index + 1];
        if (value === undefined)
          return { exitCode: 2, stdout: "", stderr: "--text requires a value" };
        text = value;
        index += 1;
        break;
      }
      case "--stdin":
        fromStdin = true;
        break;
      case "--delay-ms": {
        const value = args[index + 1];
        if (value === undefined)
          return { exitCode: 2, stdout: "", stderr: "--delay-ms requires a value" };
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5_000) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "--delay-ms must be an integer from 0 to 5000",
          };
        }
        delayMs = parsed;
        index += 1;
        break;
      }
      default:
        return { exitCode: 2, stdout: "", stderr: `Unknown vm:paste option: ${arg}` };
    }
  }
  if ((text === undefined && !fromStdin) || (text !== undefined && fromStdin)) {
    return { exitCode: 2, stdout: "", stderr: "Use exactly one of --text or --stdin" };
  }
  let pasteText: string;
  try {
    pasteText = fromStdin ? await readCliStdin(runtime) : (text as string);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  if (pasteText.length < 1 || pasteText.length > 4_096) {
    return { exitCode: 2, stdout: "", stderr: "paste text must be 1 to 4096 characters" };
  }
  const adapter = buildMcpVmAdapter(getRuntimeConfig(runtime), runtime.qmpClientFactory);
  const result = await adapter.typeText(pasteText, delayMs);
  return {
    exitCode: 0,
    stdout: `pasted ${result.textLength ?? pasteText.length} character(s) into the focused VM window`,
    stderr: "",
  };
}

async function readCliStdin(runtime: CliRuntime): Promise<string> {
  if (runtime.stdinText !== undefined) return runtime.stdinText;
  if (process.stdin.isTTY) {
    throw new CrucibleError(
      "CONFIG_INVALID",
      'vm paste --stdin requires piped stdin; use `printf %s "$VM_PASSWORD" | crucible vm paste --stdin` to avoid echoing secrets in an interactive terminal',
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.once("error", reject);
    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.resume();
  });
}

async function runVmViewCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  const parsed = parseVmViewArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const config = getRuntimeConfig(runtime);
  const port = 5900 + parsed.args.display;
  const bridgeCommand = buildVmViewBridgeCommand(
    parsed.args,
    port,
    config.vm.display.vncSocketPath,
  );
  const viewerCommand = buildVmViewCommand(parsed.args, port);
  const lines = [
    "VM view:",
    `VNC socket: ${config.vm.display.vncSocketPath}`,
    `VNC endpoint: ${parsed.args.host}:${port}`,
    `bridge command: ${formatCommand(bridgeCommand)}`,
    `viewer command: ${formatCommand(viewerCommand)}`,
    "Safety: binds the VNC bridge to loopback only; does not restart or reconfigure the VM.",
  ];

  if (parsed.args.dryRun) {
    return { exitCode: 0, stdout: ["VM view dry run:", ...lines.slice(1)].join("\n"), stderr: "" };
  }

  if (config.vm.display.mode !== "vnc") {
    return {
      exitCode: 1,
      stdout: lines.join("\n"),
      stderr: [
        `VM view requires a VM started with vm.display.mode "vnc"; current config is "${config.vm.display.mode}".`,
        'Stop the VM, set vm.display.mode to "vnc", then start it again before running `crucible vm view`.',
      ].join("\n"),
    };
  }

  const bridgeResult = await (runtime.vmViewBridgeStarter ?? startVmViewBridge)(
    bridgeCommand,
    parsed.args.host,
    port,
  );
  if (!bridgeResult.ok) {
    return {
      exitCode: 1,
      stdout: lines.join("\n"),
      stderr: [
        "Unable to expose the VM VNC socket on a loopback TCP bridge.",
        bridgeResult.error,
        "Try `crucible vm view --dry-run` to inspect the planned bridge command.",
      ].join("\n"),
    };
  }

  const launchResult = await launchVmViewer(viewerCommand, runtime.processRunner);
  if (!launchResult.ok) {
    bridgeResult.bridge.stop();
    return {
      exitCode: 1,
      stdout: lines.join("\n"),
      stderr: launchResult.error,
    };
  }

  return { exitCode: 0, stdout: [...lines, "viewer: launched"].join("\n"), stderr: "" };
}

async function runVmCredentialsCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown vm:credentials option: ${args[0]}` };
  }

  const config = getRuntimeConfig(runtime);
  const contract = buildProvisioningSecretStorageContract(
    config.vm.name,
    config.artifacts.secretsDirectory,
  );
  const [standard, admin] = await Promise.all([
    readWindowsAccountSecret(contract, "standard"),
    readWindowsAccountSecret(contract, "admin"),
  ]);

  if (standard === undefined || admin === undefined) {
    const missing = [
      standard === undefined ? "standard" : undefined,
      admin === undefined ? "admin" : undefined,
    ]
      .filter((principal): principal is string => principal !== undefined)
      .join(", ");
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        `VM credentials have not been generated yet (${missing} account missing).`,
        "Run `crucible provision` first, then retry `crucible vm credentials`.",
      ].join("\n"),
    };
  }

  return {
    exitCode: 0,
    stdout: [
      "VM credentials:",
      `secrets directory: ${contract.rootDirectory}`,
      `standard username: ${standard.username}`,
      `standard password: ${standard.password}`,
      `admin username: ${admin.username}`,
      `admin password: ${admin.password}`,
    ].join("\n"),
    stderr: "",
  };
}

async function readWindowsAccountSecret(
  contract: ReturnType<typeof buildProvisioningSecretStorageContract>,
  principal: "standard" | "admin",
): Promise<{ readonly username: string; readonly password: string } | undefined> {
  const ref = contract.secretRefs.find((secret) => secret.principal === principal);
  if (ref === undefined) return undefined;
  try {
    const parsed = JSON.parse(await readFile(ref.path, "utf8")) as {
      readonly username?: unknown;
      readonly password?: unknown;
    };
    if (typeof parsed.username !== "string" || typeof parsed.password !== "string") {
      throw new Error(`Secret file lacks username or password: ${ref.path}`);
    }
    return { username: parsed.username, password: parsed.password };
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw new Error(
      `Unable to read VM credential secret ${ref.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildVmViewBridgeCommand(
  args: VmViewArgs,
  port: number,
  vncSocketPath: string,
): readonly string[] {
  return [
    "socat",
    "-d",
    "-d",
    `TCP-LISTEN:${port},bind=${args.host},reuseaddr,listen-timeout=15`,
    `UNIX-CONNECT:${vncSocketPath}`,
  ];
}

async function startVmViewBridge(
  bridgeCommand: readonly string[],
  host: string,
  port: number,
): Promise<
  | { readonly ok: true; readonly bridge: { readonly stop: () => void } }
  | { readonly ok: false; readonly error: string }
> {
  const executable = bridgeCommand[0] ?? "socat";
  const args = bridgeCommand.slice(1);
  let logDir: string | undefined;
  let logFd: number | undefined;
  try {
    logDir = await mkdtemp(join(tmpdir(), "crucible-vnc-bridge-"));
    const logPath = join(logDir, "socat.stderr.log");
    logFd = openSync(logPath, "a");
    const child = spawn(executable, args, { detached: true, stdio: ["ignore", "ignore", logFd] });
    let stderr = "";
    const readStderr = async () => {
      stderr = (await readFile(logPath, "utf8").catch(() => stderr)).slice(-64 * 1024);
      return stderr;
    };
    const started = await new Promise<
      { readonly ok: true } | { readonly ok: false; readonly error: string }
    >((resolve) => {
      let resolved = false;
      const poll = setInterval(() => {
        void readStderr().then((output) => {
          if (output.includes("listening on")) void finish({ ok: true });
        });
      }, 25);
      const finish = async (
        result: { readonly ok: true } | { readonly ok: false; readonly error: string },
      ) => {
        if (resolved) return;
        resolved = true;
        clearInterval(poll);
        clearTimeout(timer);
        closeDetachedChildFd(logFd);
        logFd = undefined;
        await rm(logDir!, { recursive: true, force: true }).catch(() => undefined);
        resolve(result);
      };
      const timer = setTimeout(() => {
        void readStderr().then(() =>
          finish({ ok: false, error: `VNC bridge did not report listening on ${host}:${port}` }),
        );
      }, 1_000);
      child.once("error", (error) => {
        void finish({ ok: false, error: formatBridgeSpawnError(error) });
      });
      child.once("close", (code, signal) => {
        void readStderr().then((output) =>
          finish({
            ok: false,
            error: formatProcessEarlyExit(code, signal, "", output),
          }),
        );
      });
    });
    if (!started.ok) {
      stopDetachedChild(child);
      return started;
    }

    child.unref();
    return { ok: true, bridge: { stop: () => stopDetachedChild(child) } };
  } catch (error) {
    closeDetachedChildFd(logFd);
    if (logDir !== undefined)
      await rm(logDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        ok: false,
        error:
          "socat is required for `crucible vm view` but was not found in PATH. Install socat or run `crucible doctor` for host prerequisite guidance.",
      };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function closeDetachedChildFd(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Best-effort cleanup for startup diagnostics file descriptors.
  }
}

function formatBridgeSpawnError(error: Error): string {
  if ("code" in error && error.code === "ENOENT") {
    return "socat is required for `crucible vm view` but was not found in PATH. Install socat or run `crucible doctor` for host prerequisite guidance.";
  }
  return error.message;
}

function stopDetachedChild(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup for a short-lived local bridge listener.
  }
}

async function launchVmViewer(
  viewerCommand: readonly string[],
  runner: ProcessRunner | undefined,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const executable = viewerCommand[0] ?? "remote-viewer";
  const args = viewerCommand.slice(1);
  if (runner !== undefined) {
    let result: ProcessResult;
    try {
      result = await runner.run({
        executable,
        args,
        timeoutMs: 10_000,
        maxOutputBytes: 256 * 1024,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (result.exitCode !== 0 || result.timedOut) {
      return { ok: false, error: result.stderr || "viewer command failed" };
    }
    return { ok: true };
  }

  try {
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    const launched = await new Promise<
      { readonly ok: true } | { readonly ok: false; readonly error: string }
    >((resolve) => {
      let resolved = false;
      let launchAccepted = false;
      const finish = (
        result: { readonly ok: true } | { readonly ok: false; readonly error: string },
      ) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        launchAccepted = true;
        finish({ ok: true });
      }, 1_000);
      child.once("error", (error) => {
        finish({ ok: false, error: error.message });
      });
      child.once("close", (code, signal) => {
        if (launchAccepted) return;
        finish({
          ok: false,
          error: formatProcessEarlyExit(code, signal, "", ""),
        });
      });
    });
    if (!launched.ok) {
      return launched;
    }
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function formatProcessEarlyExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): string {
  const detail = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
  const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return [`process exited before it was ready (${detail})`, output].filter(Boolean).join("\n");
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

function getLifecycleManager(runtime: CliRuntime): CliLifecycleManager {
  return runtime.lifecycleManager ?? new VmLifecycleManager({ config: getRuntimeConfig(runtime) });
}

function getSnapshotManager(runtime: CliRuntime): CliSnapshotManager {
  return runtime.snapshotManager ?? new SnapshotManager({ config: getRuntimeConfig(runtime) });
}

export function buildMcpVmAdapter(
  config: CrucibleConfig,
  qmpClientFactory: () => CliQmpSession = () =>
    new QmpClient({ socketPath: config.qmp.socketPath, timeoutMs: config.qmp.timeoutMs }),
) {
  const manager = new VmLifecycleManager({ config });
  const withQmp = async <T>(operation: (qmp: CliQmpSession) => Promise<T>) => {
    const qmp = qmpClientFactory();
    try {
      await qmp.connect();
      return await operation(qmp);
    } finally {
      qmp.close();
    }
  };
  const sendInput = (events: readonly Record<string, unknown>[]) =>
    withQmp((qmp) =>
      qmp
        .execute("input-send-event", { events }, { timeoutMs: config.qmp.timeoutMs })
        .then(() => undefined),
    );
  const sendMonitorCommand = (command: string) =>
    withQmp((qmp) =>
      qmp.execute(
        "human-monitor-command",
        { "command-line": command },
        { timeoutMs: config.qmp.timeoutMs },
      ),
    );
  const buttonName = (button: QmpMouseButton) => {
    switch (button) {
      case "left":
        return "left";
      case "middle":
        return "middle";
      case "right":
        return "right";
    }
  };
  const mouseMoveEvent = (x: number) => ({
    type: "abs" as const,
    data: { axis: "x", value: x },
    // QMP absolute pointer coordinates are normalized 0..0x7fff.
  });
  const mouseAbsEvents = (x: number, y: number) => [
    mouseMoveEvent(x),
    { type: "abs" as const, data: { axis: "y", value: y } },
  ];
  const mouseButtonEvents = (button: QmpMouseButton) => [
    { type: "btn" as const, data: { button: buttonName(button), down: true } },
    { type: "btn" as const, data: { button: buttonName(button), down: false } },
  ];
  const normalizeQemuKey = (key: string) => {
    const parts = key
      .trim()
      .split(/[+-]/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      throw new CrucibleError("CONFIG_INVALID", "key must not be empty");
    }
    return parts.map((part) => QEMU_KEY_ALIASES[part] ?? part).join("-");
  };
  const assertPairedCoordinates = (x: number | undefined, y: number | undefined) => {
    if ((x === undefined) !== (y === undefined)) {
      throw new CrucibleError("CONFIG_INVALID", "x and y must be supplied together");
    }
  };
  const render = async () => {
    const status = await manager.status();
    return {
      state: status.status,
      pid: status.pid,
      startedAt: status.stateManifest?.startedAt,
    };
  };
  return {
    status: render,
    start: async () => {
      await manager.start();
      return render();
    },
    stop: async () => {
      await manager.stop();
      return render();
    },
    screenshot: async (outputPath: string) => {
      await mkdir(dirname(outputPath), { recursive: true });
      const isPng = outputPath.endsWith(".png");
      const ppmPath = isPng ? `${outputPath}.tmp.ppm` : outputPath;
      const qmp = qmpClientFactory();
      try {
        await qmp.connect();
        await qmp.execute("screendump", { filename: ppmPath }, { timeoutMs: config.qmp.timeoutMs });
      } finally {
        qmp.close();
      }
      if (isPng) {
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("convert", [ppmPath, outputPath], { timeout: 10_000 });
        } finally {
          await rm(ppmPath, { force: true });
        }
      }
      const fileInfo = await fsStat(outputPath);
      return { path: outputPath, sizeBytes: fileInfo.size };
    },
    displayInfo: async () => {
      try {
        const commands = await withQmp(async (qmp) => {
          const result = await qmp.execute<Array<{ name?: string }>>("query-commands", undefined, {
            timeoutMs: config.qmp.timeoutMs,
          });
          return new Set(
            result.returnValue
              .map((command) => command.name)
              .filter((name): name is string => name !== undefined),
          );
        });
        const mouseAvailable = commands.has("input-send-event");
        const keyAvailable = commands.has("human-monitor-command");
        const inputAvailable = mouseAvailable || keyAvailable;
        const inputBackends = [
          mouseAvailable ? "qmp-input-send-event" : undefined,
          keyAvailable ? "qmp-human-monitor-command" : undefined,
        ].filter((backend): backend is string => backend !== undefined);
        return {
          available: true,
          backend: inputBackends.length > 0 ? inputBackends.join("+") : "qmp",
          inputAvailable,
          message:
            inputBackends.length > 0
              ? `QMP display is reachable; input backend(s): ${inputBackends.join(", ")}.`
              : "QMP display is reachable, but display input commands are unavailable.",
        };
      } catch (error) {
        return {
          available: false,
          backend: "qmp",
          inputAvailable: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    mouseMove: async (x: number, y: number) => {
      await sendInput(mouseAbsEvents(x, y));
      return { action: "mouse_move", backend: "qmp-input-send-event", x, y };
    },
    mouseClick: async (input: {
      readonly x?: number;
      readonly y?: number;
      readonly button: "left" | "middle" | "right";
    }) => {
      assertPairedCoordinates(input.x, input.y);
      const events = input.x === undefined ? [] : mouseAbsEvents(input.x, input.y as number);
      await sendInput([...events, ...mouseButtonEvents(input.button)]);
      return { action: "mouse_click", backend: "qmp-input-send-event", ...input };
    },
    mouseDoubleClick: async (input: {
      readonly x?: number;
      readonly y?: number;
      readonly button: "left" | "middle" | "right";
    }) => {
      assertPairedCoordinates(input.x, input.y);
      const events = input.x === undefined ? [] : mouseAbsEvents(input.x, input.y as number);
      await sendInput([
        ...events,
        ...mouseButtonEvents(input.button),
        ...mouseButtonEvents(input.button),
      ]);
      return { action: "mouse_double_click", backend: "qmp-input-send-event", ...input };
    },
    mouseDrag: async (input: {
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly button: "left" | "middle" | "right";
    }) => {
      await sendInput([
        ...mouseAbsEvents(input.fromX, input.fromY),
        { type: "btn", data: { button: buttonName(input.button), down: true } },
        ...mouseAbsEvents(input.toX, input.toY),
        { type: "btn", data: { button: buttonName(input.button), down: false } },
      ]);
      return {
        action: "mouse_drag",
        backend: "qmp-input-send-event",
        x: input.toX,
        y: input.toY,
        button: input.button,
      };
    },
    keyPress: async (key: string) => {
      const normalized = normalizeQemuKey(key);
      await sendMonitorCommand(`sendkey ${normalized}`);
      return { action: "key_press", backend: "qmp-human-monitor-command", key: normalized };
    },
    typeText: async (text: string, delayMs?: number) => {
      const normalizedText = normalizeVmTextInput(text);
      const commands = [...normalizedText].map((key) => `sendkey ${qemuKeyForTextInput(key)}`);
      await withQmp(async (qmp) => {
        for (const command of commands) {
          await qmp.execute(
            "human-monitor-command",
            { "command-line": command },
            { timeoutMs: config.qmp.timeoutMs },
          );
          if (delayMs !== undefined && delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      });
      return {
        action: "type_text",
        backend: "qmp-human-monitor-command",
        textLength: normalizedText.length,
      };
    },
  };
}

function buildMcpSnapshotAdapter(config: CrucibleConfig) {
  const manager = new SnapshotManager({ config });
  const render = (snapshot: SnapshotRecord) => ({
    name: snapshot.name,
    path: snapshot.path,
    createdAt: snapshot.createdAt,
  });
  return {
    list: async () => (await manager.list()).map(render),
    restore: async (snapshotName: string) => render((await manager.restore(snapshotName)).snapshot),
  };
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

async function runProvisionCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown provision option: ${args[0]}` };
  }

  const config = getRuntimeConfig(runtime);

  // Eagerly validate that the cross-compiled agent binary exists before
  // we kick off the (long) Windows install. Without this the operator
  // discovers the missing binary 15 minutes in, after the guest is
  // already provisioned, when install-agent fails to upload it.
  if (runtime.lifecycleManager === undefined && runtime.provisioningExecutor === undefined) {
    const agentBinaryPath = await resolveGuestAgentBinaryPath();
    if (!(await fileExists(agentBinaryPath))) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: [
          `Cannot find the Windows guest agent binary at ${agentBinaryPath}.`,
          "Use the npm package with bundled vendor/crucible-guest-agent.exe,",
          "build it via 'scripts/package-release.sh', or set CRUCIBLE_GUEST_AGENT_BINARY",
          "to a pre-built crucible-guest-agent.exe.",
        ].join("\n"),
      };
    }
  }

  const lifecyclePrep = await getProvisioningLifecyclePreparation(config, runtime);

  // Own an AbortController so the moment QEMU is observed to have exited
  // (Windows S5, OVMF crash, OOM, ...) we can cancel every in-flight QGA
  // retry instantly instead of burning a 5-minute per-call budget against
  // a dead socket. The CLI is the only layer that knows the lifecycle is
  // about to be torn down, so it owns the signal.
  const lifecycleAbort = new AbortController();
  let activeLifecycleManager = lifecyclePrep.lifecycleManager;
  const activeLifecycle: CliLifecycleManager = {
    get paths() {
      return activeLifecycleManager.paths;
    },
    start: () => activeLifecycleManager.start(),
    stop: () => activeLifecycleManager.stop(),
    poweroff: () => activeLifecycleManager.poweroff(),
    kill: () => activeLifecycleManager.kill(),
    status: () => activeLifecycleManager.status(),
  };

  // When the CLI owns the lifecycle (no injected lifecycleManager /
  // provisioningExecutor), build a default executor that stages mTLS
  // material + the cross-compiled agent binary before
  // `install-guest-agent` runs.
  const executor =
    runtime.provisioningExecutor ??
    buildDefaultProvisioningExecutor(config, lifecyclePrep, lifecycleAbort.signal);

  const livenessHandle = startLifecycleLivenessPoller(activeLifecycle, lifecycleAbort);
  const progress = runtime.progress ?? createProvisionProgressReporter();
  const progressExecutor: ProvisioningExecutor = {
    runStage(stage) {
      progress.stageStarted(stage);
      return executor.runStage(stage);
    },
  };
  let provisionRejected = false;

  try {
    progress.start();
    const result = await runProvisioningCommand({
      config,
      lifecycleManager: activeLifecycle,
      executor: progressExecutor,
      snapshotManager: runtime.snapshotManager ?? new SnapshotManager({ config }),
      skipBootKeyNudge: runtime.skipBootKeyNudge,
      afterStage: async (stage) => {
        progress.stageCompleted(stage);
        if (
          stage.id !== "analysis-tools-installed" ||
          lifecyclePrep.finalLifecycleManager === undefined
        ) {
          return;
        }
        await lifecyclePrep.lifecycleManager.stop();
        activeLifecycleManager = lifecyclePrep.finalLifecycleManager;
        await activeLifecycleManager.start();
        if (runtime.provisioningExecutor === undefined) {
          await waitForQgaAfterNetworkRestart(config, lifecycleAbort.signal);
        }
      },
    });
    progress.finish(result.status);

    return {
      exitCode: result.status === "complete" ? 0 : 1,
      stdout: renderProvisioningResult(result),
      stderr: "",
    };
  } catch (error) {
    provisionRejected = true;
    progress.finish("failed");
    // Best-effort lifecycle teardown so we don't leave QEMU + swtpm orphaned
    // after a fatal provisioning error. Only attempts kill if the process is
    // still alive — a successful guest-initiated S5 is also possible here.
    // Skip the kill when CRUCIBLE_KEEP_VM_ON_FAILURE is set so an operator
    // can attach via qga / qmp and debug the failing stage interactively.
    if (process.env.CRUCIBLE_KEEP_VM_ON_FAILURE !== "1") {
      await tryKillLifecycle(activeLifecycle);
    }
    throw error;
  } finally {
    livenessHandle.stop();
    // Only abort on the error path. On a successful provision we leave the
    // signal alone; the executor's last call has already resolved so no
    // straggler retry needs releasing, and aborting here would surface a
    // misleading STATE_INVALID rejection if anything was still racing.
    if (provisionRejected && !lifecycleAbort.signal.aborted) {
      lifecycleAbort.abort(
        new CrucibleError("STATE_INVALID", "provisioning failed; aborting in-flight QGA retries"),
      );
    }
  }
}

async function waitForQgaAfterNetworkRestart(
  config: CrucibleConfig,
  signal: AbortSignal,
): Promise<void> {
  const client = new QgaClient({
    socketPath: config.qga.socketPath,
    timeoutMs: config.qga.timeoutMs,
    signal,
  });
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.ping();
      return;
    } catch (error) {
      lastError = error;
      await sleepRespectingAbort(2_000, signal);
    }
  }
  throw new CrucibleError(
    "QMP_TIMEOUT",
    "Timed out waiting for QGA after final-network restart",
    lastError,
  );
}

function sleepRespectingAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReasonAsError(signal.reason));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(abortReasonAsError(signal.reason));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function abortReasonAsError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string") {
    return new Error(reason);
  }
  return new Error("operation aborted");
}

type LifecycleLivenessHandle = { readonly stop: () => void };

function startLifecycleLivenessPoller(
  manager: CliLifecycleManager,
  abort: AbortController,
): LifecycleLivenessHandle {
  const intervalMs = 5_000;
  let stopped = false;
  let inFlight = false;
  // QMP runstates that mean "guest is no longer making progress and qemu-ga
  // has gone away" — these are exactly the cases where -no-shutdown leaves
  // the QEMU host process alive but every QGA call is doomed. See
  // https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html#qapidoc-43
  const deadQmpRunstates = new Set([
    "shutdown",
    "guest-panicked",
    "internal-error",
    "io-error",
    "watchdog",
  ]);
  const handle = setInterval(() => {
    // Skip this tick if the previous status() call hasn't finished —
    // a slow QMP connect timeout can take longer than intervalMs and
    // we don't want to stack concurrent QMP sessions.
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    void (async () => {
      try {
        const status = await manager.status({ queryQmp: true });
        const isHostDead = status.processAlive === false && status.pid !== undefined;
        const isGuestDead =
          status.qmpStatus !== undefined && deadQmpRunstates.has(status.qmpStatus);
        if ((isHostDead || isGuestDead) && !abort.signal.aborted) {
          const reason = isHostDead
            ? `QEMU pid ${status.pid} has exited; aborting provision`
            : `QEMU guest runstate is '${status.qmpStatus}'; aborting provision`;
          abort.abort(new CrucibleError("STATE_INVALID", reason));
        }
      } catch {
        // status() failures are not fatal — keep polling.
      } finally {
        inFlight = false;
      }
    })();
  }, intervalMs);
  handle.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

async function tryKillLifecycle(manager: CliLifecycleManager): Promise<void> {
  try {
    const status = await manager.status({ queryQmp: false });
    if (status.processAlive === true && "kill" in manager && typeof manager.kill === "function") {
      await (manager as { kill: () => Promise<unknown> }).kill();
    }
  } catch {
    // best-effort
  }
}

function createProvisionProgressReporter(): ProvisionProgressReporter {
  if (process.stderr.isTTY !== true || process.stdout.isTTY !== true) {
    return noopProvisionProgressReporter;
  }
  const startedAt = Date.now();
  let completed = 0;
  const total = PROVISIONING_STAGE_IDS.length;
  let current = "starting";
  const render = () => {
    const elapsed = formatDuration(Date.now() - startedAt);
    const width = 24;
    const filled = Math.round((completed / total) * width);
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
    process.stderr.clearLine(0);
    process.stderr.cursorTo(0);
    process.stderr.write(
      `[${bar}] ${completed}/${total} ${current} elapsed ${elapsed} ETA unknown`,
    );
  };
  return {
    start() {
      render();
    },
    stageStarted(stage) {
      current = stage.title;
      render();
    },
    stageCompleted(stage) {
      completed = Math.min(total, completed + 1);
      current = stage.title;
      render();
    },
    finish(status) {
      current = status;
      if (status === "complete") completed = total;
      render();
      process.stderr.write("\n");
    },
  };
}

const noopProvisionProgressReporter: ProvisionProgressReporter = {
  start() {},
  stageStarted() {},
  stageCompleted() {},
  finish() {},
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

type ProvisioningLifecyclePreparation = {
  readonly lifecycleManager: CliLifecycleManager;
  readonly finalLifecycleManager?: CliLifecycleManager;
  readonly firstBootPlan?: Awaited<ReturnType<typeof prepareRealFirstBootProvisioning>>;
};

function buildDefaultProvisioningExecutor(
  config: CrucibleConfig,
  prep: ProvisioningLifecyclePreparation,
  signal: AbortSignal,
): QgaProvisioningExecutor {
  // mTLS material + the agent binary + every per-stage PowerShell
  // script are now baked into crucible-payload.iso and mounted as the
  // 4th CD-ROM at VM start. install-agent.ps1 copies them into place
  // via Win32 file I/O. We deliberately do NOT use qemu-ga writeFile
  // here: see #130 — the guest-file-open + Windows-filesystem-minifilter
  // race is unfixable on Win11 25H2 from the host side.
  void prep;
  return new QgaProvisioningExecutor({
    client: new QgaClient({
      socketPath: config.qga.socketPath,
      timeoutMs: config.qga.timeoutMs,
      signal,
    }),
    vmName: config.vm.name,
    secretsDirectory: config.artifacts.secretsDirectory,
  });
}

/**
 * Resolve a path to the cross-compiled Windows guest agent binary that
 * `install-agent.ps1` expects in C:\Program Files\Crucible. Operators can
 * override via $CRUCIBLE_GUEST_AGENT_BINARY; otherwise packaged npm
 * installs use vendor/crucible-guest-agent.exe and source checkouts fall
 * back to the conventional dist/release output produced by
 * scripts/package-release.sh.
 */
async function resolveGuestAgentBinaryPath(): Promise<string> {
  const override = process.env.CRUCIBLE_GUEST_AGENT_BINARY;
  if (override !== undefined && override !== "") {
    return resolvePath(override);
  }
  for (const candidate of defaultGuestAgentBinaryCandidates()) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return (
    defaultGuestAgentBinaryCandidates()[0] ?? resolvePath("dist/release/crucible-guest-agent.exe")
  );
}

function defaultGuestAgentBinaryCandidates(): readonly string[] {
  const modulePath = fileURLToPath(import.meta.url);
  const sourceCheckoutCandidate = resolvePath("dist/release/crucible-guest-agent.exe");
  const packagedCandidate = resolvePath(
    dirname(modulePath),
    "..",
    "vendor",
    "crucible-guest-agent.exe",
  );
  return modulePath.includes(`${resolvePath("packages", "cli", "src")}/`)
    ? [sourceCheckoutCandidate, packagedCandidate]
    : [packagedCandidate, sourceCheckoutCandidate];
}

async function resolveProvisioningScriptsDirectory(): Promise<string> {
  for (const candidate of defaultProvisioningScriptCandidates()) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return defaultProvisioningScriptCandidates()[0] ?? resolvePath("guest/provision");
}

function defaultProvisioningScriptCandidates(): readonly string[] {
  const modulePath = fileURLToPath(import.meta.url);
  return [
    resolvePath(dirname(modulePath), "..", "guest", "provision"),
    resolvePath("guest", "provision"),
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsStat(filePath);
    return true;
  } catch {
    return false;
  }
}

function getExampleConfigJson(): string {
  return JSON.stringify(
    {
      $schema:
        "https://raw.githubusercontent.com/Adamkadaban/crucible/main/schemas/config.schema.json",
      vm: {
        name: "crucible-win11",
        cpus: 4,
        memoryMiB: 8192,
        diskGiB: 128,
        display: { mode: "none", vncSocketPath: "artifacts/vnc.sock" },
      },
      media: {
        cacheDir: "media/cache",
        profile: "windows11-enterprise-eval",
        windowsIso: { path: "/path/to/windows.iso" },
        virtioIso: { path: "/path/to/virtio-win.iso" },
        driverBundle: { path: "/path/to/virtio-win-guest-tools.exe" },
      },
      network: {
        mode: "isolated",
        controlPort: 8443,
      },
      realism: {
        enabled: false,
        seed: "optional-reproducible-seed",
        profile: "office-user",
        populateUserFiles: true,
      },
      qmp: {
        socketPath: "artifacts/qmp.sock",
        timeoutMs: 5000,
      },
      qga: {
        socketPath: "artifacts/qga.sock",
        timeoutMs: 10000,
      },
      artifacts: {
        directory: "artifacts",
        manifestPath: "artifacts/manifest.json",
        logsDirectory: "artifacts/logs",
        snapshotsDirectory: "snapshots",
        secretsDirectory: "artifacts/secrets",
      },
    },
    null,
    2,
  );
}

async function getProvisioningLifecyclePreparation(
  config: CrucibleConfig,
  runtime: CliRuntime,
): Promise<ProvisioningLifecyclePreparation> {
  if (runtime.lifecycleManager !== undefined || runtime.provisioningExecutor !== undefined) {
    return {
      lifecycleManager: getLifecycleManager(runtime),
      finalLifecycleManager: runtime.finalLifecycleManager,
    };
  }

  const processRunner = runtime.processRunner ?? nodeProcessRunner;
  const firstBootPlan = await prepareRealFirstBootProvisioning({
    config,
    processRunner,
    agentBinaryPath: await resolveGuestAgentBinaryPath(),
    provisioningScriptsDirectory: await resolveProvisioningScriptsDirectory(),
  });
  const qemuPlan = buildQemuCommandPlan({
    config: { ...config, network: { ...config.network, mode: "nat" } },
    diskPath: firstBootPlan.diskPath,
    bootMedia: {
      windowsIsoPath: config.media.windowsIso?.path,
      virtioIsoPath: config.media.virtioIso?.path,
      driverBundlePath: config.media.driverBundle?.path,
      autounattendIsoPath: firstBootPlan.autounattendIsoPath,
      payloadIsoPath: firstBootPlan.payloadIsoPath,
      ovmfCodePath: firstBootPlan.ovmfCodePath,
      ovmfVarsPath: firstBootPlan.ovmfVarsPath,
    },
  });
  const finalQemuPlan = buildQemuCommandPlan({
    config,
    diskPath: firstBootPlan.diskPath,
    bootMedia: {
      ovmfCodePath: firstBootPlan.ovmfCodePath,
      ovmfVarsPath: firstBootPlan.ovmfVarsPath,
      payloadIsoPath: firstBootPlan.payloadIsoPath,
    },
  });

  return {
    lifecycleManager: new VmLifecycleManager({ config, plan: qemuPlan }),
    finalLifecycleManager: new VmLifecycleManager({ config, plan: finalQemuPlan }),
    firstBootPlan,
  };
}

const nodeProcessRunner: ProcessRunner = {
  run(command) {
    return runNodeProcess(command);
  },
};

async function runNodeProcess(command: ProcessCommand): Promise<ProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env === undefined ? process.env : { ...process.env, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const maxOutputBytes = command.maxOutputBytes ?? 1024 * 1024;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, command.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = boundedAppend(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = boundedAppend(stderr, chunk, maxOutputBytes);
    });
    let settled = false;
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

function boundedAppend(current: string, chunk: string, maxBytes: number): string {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return next;
  }
  return Buffer.from(next, "utf8").subarray(-maxBytes).toString("utf8");
}

async function runGuestHealthCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown guest:health option: ${args[0]}` };
  }

  const config = getRuntimeConfig(runtime);
  const guestClientFactory = runtime.guestClientFactory ?? buildDefaultGuestClientFactory(config);
  if (guestClientFactory !== undefined) {
    try {
      const client = await guestClientFactory();
      try {
        const health = await client.health();
        const policyHealth = await readGuestPolicyHealth(client, config);
        const healthy = health.status === "ok" && policyHealth.healthy;
        return {
          exitCode: healthy ? 0 : 1,
          stdout: renderGuestAgentHealth(health, policyHealth, healthy),
          stderr: "",
        };
      } finally {
        await client.close();
      }
    } catch (error) {
      if (
        runtime.guestClientFactory !== undefined ||
        hasExplicitGuestClientEnv() ||
        !isMissingPathError(error)
      ) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const report = buildGuestHealthReport({
    config,
    lifecycleStatus: await getLifecycleManager(runtime).status(),
  });

  return {
    exitCode: report.status === "healthy" ? 0 : 1,
    stdout: renderGuestHealth(report),
    stderr: "",
  };
}

async function runGuestExecCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  const parsed = parseGuestExecArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const config = getRuntimeConfig(runtime);
  const guestClientFactory = runtime.guestClientFactory ?? buildDefaultGuestClientFactory(config);
  if (guestClientFactory === undefined) {
    return { exitCode: 1, stdout: "", stderr: "guest client is not configured" };
  }

  const client = await guestClientFactory();
  try {
    const result = await client.exec({
      executable: parsed.args.executable,
      arguments: parsed.args.arguments,
      as: parsed.args.as,
    });
    return {
      exitCode: result.exitCode,
      stdout: renderGuestExecResult(result),
      stderr: "",
    };
  } finally {
    await client.close();
  }
}

async function runDebugSmokeCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  const parsed = parseDebugSmokeArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const config = getRuntimeConfig(runtime);
  const guestClientFactory = runtime.guestClientFactory ?? buildDefaultGuestClientFactory(config);
  if (guestClientFactory === undefined) {
    return { exitCode: 1, stdout: "", stderr: "guest client is not configured" };
  }
  const client = await guestClientFactory();
  try {
    const cdbPath = (await client.health()).cdbPath ?? "cdb.exe";
    const manager = new DebuggerSessionManager({
      run: async (cdbArgs) => {
        const result = await client.exec({
          executable: cdbPath,
          arguments: [...cdbArgs],
          as: "service",
          timeoutMs: 5 * 60 * 1000,
        });
        return {
          stdoutBase64: result.stdoutBase64 ?? "",
          stderrBase64: result.stderrBase64 ?? "",
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
        };
      },
    });
    const session = manager.open({ mode: "launch", executable: parsed.executable });
    const result = await manager.command(session.id, ["~* k", "lm"]);
    const smokeSucceeded = !result.timedOut && (result.exitCode === 0 || result.exitCode === 1);
    return {
      exitCode: smokeSucceeded ? 0 : (result.exitCode ?? 1),
      stdout: renderDebuggerSmokeResult(session.id, result),
      stderr: "",
    };
  } finally {
    await client.close();
  }
}

async function runMalwareDryRunCommand(args: readonly string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Unknown scenario:malware-dry-run option: ${args[0]}`,
    };
  }
  const records: string[] = [];
  const result = await runScenario(
    {
      id: "malware-dry-run",
      preRestoreSnapshot: "clean-base",
      steps: [
        {
          id: "upload-sample",
          title: "upload benign sample",
          kind: "scenario-step",
          run: () => {
            records.push("upload sample: dry-run");
            return Promise.resolve();
          },
        },
        {
          id: "execute-sample",
          title: "execute benign sample",
          kind: "scenario-step",
          run: () => {
            records.push("execute sample: dry-run");
            return Promise.resolve();
          },
        },
        {
          id: "collect-artifacts",
          title: "collect artifacts",
          kind: "scenario-step",
          run: () => {
            records.push("collect artifacts: dry-run");
            return Promise.resolve();
          },
        },
      ],
    },
    {
      restoreSnapshot: (snapshotName) => {
        records.push(`restore snapshot: ${snapshotName}`);
        return Promise.resolve();
      },
      now: () => 0,
    },
  );
  return {
    exitCode: result.status === "succeeded" ? 0 : 1,
    stdout: renderScenarioResult(result, records),
    stderr: "",
  };
}

async function runPackageCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown package option: ${args[0]}` };
  }
  const runner = runtime.processRunner ?? nodeProcessRunner;
  const command: ProcessCommand = {
    executable: "bash",
    args: ["scripts/package-release.sh"],
    timeoutMs: 5 * 60 * 1000,
    maxOutputBytes: 2 * 1024 * 1024,
  };
  const result = await runner.run(command);
  if (result.exitCode !== 0 || result.timedOut) {
    return {
      exitCode: result.timedOut ? 1 : (result.exitCode ?? 1),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    exitCode: 0,
    stdout: [`Package command: ${describeCommand(command)}`, result.stdout.trimEnd()]
      .filter(Boolean)
      .join("\n"),
    stderr: result.stderr.trimEnd(),
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

function renderProvisioningResult(result: ProvisioningCommandResult): string {
  const lines = [
    `Provisioning status: ${result.status}`,
    `VM: ${result.vmName}`,
    `Clean snapshot: ${result.snapshotName}`,
    "Steps:",
    ...result.steps.map((step) => `- ${step.id}: ${step.status} (${step.detail})`),
    "",
    renderGuestHealth(result.health),
  ];

  if (result.snapshot !== undefined) {
    lines.push("", renderSnapshotCreateResult(result.snapshot));
  }

  if (result.status === "blocked") {
    lines.push("", "Manual media recovery:", getManualDownloadInstructions());
  }

  return lines.join("\n");
}

function renderGuestHealth(report: GuestHealthReport): string {
  return [
    `Guest health: ${report.status}`,
    `VM: ${report.vmName}`,
    `generated at: ${report.generatedAt}`,
    `lifecycle status: ${report.lifecycleStatus}`,
    `qmp available: ${report.qmpAvailable ? "yes" : "no"}`,
    `vm process alive: ${report.vmProcessAlive ? "yes" : "no"}`,
    `control endpoint: ${report.controlEndpoint}`,
    "checks:",
    ...report.checks.map(
      (check) => `- ${check.id}: ${check.status} (${check.detail ?? check.description})`,
    ),
  ].join("\n");
}

function renderGuestAgentHealth(
  health: GuestAgentHealth,
  policyHealth?: GuestPolicyHealth,
  healthy = health.status === "ok" && (policyHealth?.healthy ?? true),
): string {
  const lines = [
    `Guest health: ${healthy ? "healthy" : "unhealthy"}`,
    `guest agent status: ${health.status}`,
    `version: ${health.version}`,
    `host name: ${health.hostName}`,
    `started at: ${health.startedAt}`,
    `uptime seconds: ${health.uptimeSeconds}`,
    `go version: ${health.goVersion}`,
    `WinDbg installed: ${health.windbgInstalled ? "yes" : "no"}`,
    `CDB path: ${health.cdbPath ?? "missing"}`,
    `WinDbg path: ${health.windbgPath ?? "missing"}`,
  ];

  if (policyHealth !== undefined) {
    lines.push(
      "policy:",
      `- CDB path: ${policyHealth.cdbPath ?? "missing"}`,
      `- WinDbg path: ${policyHealth.windbgPath ?? "missing"}`,
      `- KD path: ${policyHealth.kdPath ?? "missing"}`,
      `- KDNET path: ${policyHealth.kdnetPath ?? "missing"}`,
      `- GFlags path: ${policyHealth.gflagsPath ?? "missing"}`,
      `- symbol path: ${policyHealth.symbolPath ?? "missing"}`,
      `- symbol cache: ${policyHealth.symbolCachePath ?? "missing"}`,
      `- symbol cache writable: ${formatBoolean(policyHealth.symbolCacheWritable)}`,
      `- Sysinternals: ${formatToolMap(policyHealth.sysinternals)}`,
      `- ${policyHealth.adminUsername ?? "CrucibleAdmin"} present: ${policyHealth.crucibleAdminPresent ? "yes" : "no"}`,
      `- ${policyHealth.standardUsername ?? "CrucibleUser"} present: ${policyHealth.crucibleUserPresent ? "yes" : "no"}`,
      `- qemu-ga service: ${policyHealth.qemuAgentStatus ?? "unknown"}`,
      `- CrucibleGuestAgent service: ${policyHealth.crucibleAgentStatus ?? "unknown"}`,
      `- Defender real-time protection: ${formatBoolean(policyHealth.defenderRealTimeProtectionEnabled)}`,
      `- code-integrity state recorded: ${policyHealth.codeIntegrityStateRecorded ? "yes" : "no"}`,
      `- code-integrity enforcement disabled: ${formatRecordedBoolean(policyHealth.codeIntegrityEnforcementDisabled, policyHealth.codeIntegrityStateRecorded)}`,
      `- HVCI disabled: ${formatRecordedBoolean(policyHealth.hypervisorEnforcedCodeIntegrityDisabled, policyHealth.codeIntegrityStateRecorded)}`,
      `- code-integrity boot options: ${policyHealth.codeIntegrityBootOptions.length > 0 ? policyHealth.codeIntegrityBootOptions.join(", ") : "none"}`,
      `- test signing enabled: ${formatBoolean(policyHealth.testSigningEnabled)}`,
      `- policy health: ${policyHealth.healthy ? "healthy" : "unhealthy"}`,
    );
  }

  return lines.join("\n");
}

function renderGuestExecResult(result: GuestAgentExecResult): string {
  const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64")
    .toString("utf8")
    .trimEnd();
  const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
    .toString("utf8")
    .trimEnd();
  return [
    `exit code: ${result.exitCode}`,
    `timed out: ${result.timedOut ? "yes" : "no"}`,
    `duration ms: ${result.durationMs}`,
    `truncated: ${result.truncated ? "yes" : "no"}`,
    "stdout:",
    stdout.length > 0 ? stdout : "(empty)",
    "stderr:",
    stderr.length > 0 ? stderr : "(empty)",
  ].join("\n");
}

function renderDebuggerSmokeResult(
  sessionId: string,
  result: {
    readonly stdoutBase64: string;
    readonly stderrBase64: string;
    readonly exitCode?: number;
    readonly timedOut: boolean;
    readonly truncated: boolean;
    readonly durationMs: number;
  },
): string {
  const stdout = Buffer.from(result.stdoutBase64, "base64").toString("utf8").trimEnd();
  const stderr = Buffer.from(result.stderrBase64, "base64").toString("utf8").trimEnd();
  return [
    `debug session: ${sessionId}`,
    `exit code: ${result.exitCode ?? "unknown"}`,
    `timed out: ${result.timedOut ? "yes" : "no"}`,
    `duration ms: ${result.durationMs}`,
    `truncated: ${result.truncated ? "yes" : "no"}`,
    "stdout:",
    stdout.length > 0 ? stdout : "(empty)",
    "stderr:",
    stderr.length > 0 ? stderr : "(empty)",
  ].join("\n");
}

function renderScenarioResult(
  result: Awaited<ReturnType<typeof runScenario>>,
  actions: readonly string[],
): string {
  return [
    `Scenario: ${result.scenarioId}`,
    `status: ${result.status}`,
    "records:",
    ...result.records.map((record) => `- ${record.id}: ${record.status} (${record.title})`),
    "dry-run actions:",
    ...actions.map((action) => `- ${action}`),
    "Internet egress: denied by default",
  ].join("\n");
}

function formatBoolean(value: boolean | null | undefined): string {
  if (value === undefined || value === null) {
    return "unknown";
  }
  return value ? "yes" : "no";
}

function formatToolMap(tools: Readonly<Record<string, string | null>> | undefined): string {
  if (tools === undefined) {
    return "unknown";
  }
  const entries = Object.entries(tools).map(([name, value]) => `${name}=${value ?? "missing"}`);
  return entries.length > 0 ? entries.join(", ") : "none";
}

function formatRecordedBoolean(value: boolean, recorded: boolean): string {
  return recorded ? formatBoolean(value) : "unknown";
}

async function readGuestPolicyHealth(
  client: CliGuestHealthClient,
  config: CrucibleConfig,
): Promise<GuestPolicyHealth> {
  const command = buildGuestPolicyHealthCommand(await readConfiguredWindowsAccountNames(config));
  const result = await client.exec({
    executable: "powershell.exe",
    arguments: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    timeoutMs: 30_000,
  });
  const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64")
    .toString("utf8")
    .trim();
  if (result.exitCode !== 0 || result.timedOut) {
    const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
      .toString("utf8")
      .trim();
    throw new Error(
      `guest policy health failed: exit=${result.exitCode} timedOut=${result.timedOut} ${stderr}`,
    );
  }
  return JSON.parse(stdout) as GuestPolicyHealth;
}

async function readConfiguredWindowsAccountNames(config: CrucibleConfig): Promise<{
  readonly standardUsername: string;
  readonly adminUsername: string;
}> {
  const contract = buildProvisioningSecretStorageContract(
    config.vm.name,
    config.artifacts.secretsDirectory,
  );
  const readUsername = async (principal: "standard" | "admin", fallback: string) => {
    const ref = contract.secretRefs.find((secret) => secret.principal === principal);
    if (ref === undefined) return fallback;
    try {
      const parsed = JSON.parse(await readFile(ref.path, "utf8")) as { username?: unknown };
      return typeof parsed.username === "string" && parsed.username.length > 0
        ? parsed.username
        : fallback;
    } catch (error) {
      if (isMissingPathError(error)) return fallback;
      throw error;
    }
  };

  return {
    standardUsername: await readUsername("standard", "CrucibleUser"),
    adminUsername: await readUsername("admin", "CrucibleAdmin"),
  };
}

function buildGuestPolicyHealthCommand(accountNames: {
  readonly standardUsername: string;
  readonly adminUsername: string;
}): string {
  const standardUsername = powerShellSingleQuoted(accountNames.standardUsername);
  const adminUsername = powerShellSingleQuoted(accountNames.adminUsername);
  return String.raw`$ErrorActionPreference='Stop';
function Find-Dbg([string[]]$Names){
  foreach($name in $Names){$cmd=Get-Command $name -ErrorAction SilentlyContinue; if($null -ne $cmd){return $cmd.Source}}
  $dirs=@("$env:ProgramFiles\Windows Kits\10\Debuggers\x64", "$env:LOCALAPPDATA\Microsoft\WindowsApps")
  $programFilesX86=[Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if(-not [string]::IsNullOrWhiteSpace($programFilesX86)){$dirs += "$programFilesX86\Windows Kits\10\Debuggers\x64"}
  foreach($dir in $dirs){if([string]::IsNullOrWhiteSpace($dir)-or -not(Test-Path -LiteralPath $dir)){continue}; foreach($name in $Names){$p=Join-Path $dir $name; if(Test-Path -LiteralPath $p -PathType Leaf){return $p}}}
  return $null
}
function Test-User([string]$Name){try{$null=Get-LocalUser -Name $Name -ErrorAction Stop; return $true}catch{return $false}}
function Find-Tool([string[]]$Names){$dirs=@('C:\Tools','C:\Tools\Sysinternals','C:\Tools\Malware'); foreach($name in $Names){$cmd=Get-Command $name -ErrorAction SilentlyContinue; if($null -ne $cmd){return $cmd.Source}}; foreach($dir in $dirs){if(-not(Test-Path -LiteralPath $dir)){continue}; foreach($name in $Names){$p=Join-Path $dir $name; if(Test-Path -LiteralPath $p -PathType Leaf){return $p}}}; return $null}
function ServiceStatus([string]$Name){$s=Get-Service -Name $Name -ErrorAction SilentlyContinue; if($null -eq $s){return 'missing'}; return $s.Status.ToString()}
function DefenderRtp(){try{$s=Get-MpComputerStatus -ErrorAction Stop; return [bool]$s.RealTimeProtectionEnabled}catch{return $null}}
function DwordValue([string]$Path,[string]$Name){try{$i=Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop; return [int]($i.$Name)}catch{return $null}}
function CodeIntegrityBootOptions(){try{$b=& bcdedit /enum 2>$null; if($LASTEXITCODE -ne 0){return @()}; $o=@(); if($b | Select-String -Pattern '^\s*nointegritychecks\s+Yes\s*$' -Quiet){$o += 'nointegritychecks'}; if($b | Select-String -Pattern '^\s*testsigning\s+Yes\s*$' -Quiet){$o += 'testsigning'}; return @($o)}catch{return @()}}
function TestSigning(){try{$b=& bcdedit /enum '{current}' 2>$null; if($LASTEXITCODE -ne 0){return $null}; return [bool]($b | Select-String -Pattern 'testsigning\s+Yes' -Quiet)}catch{return $null}}
$adminUsername=${adminUsername}; $standardUsername=${standardUsername}; $cdb=Find-Dbg @('cdb.exe'); $windbg=Find-Dbg @('windbg.exe','WinDbgX.exe'); $kd=Find-Dbg @('kd.exe'); $kdnet=Find-Dbg @('kdnet.exe'); $gflags=Find-Dbg @('gflags.exe'); $symbol=[Environment]::GetEnvironmentVariable('_NT_SYMBOL_PATH','Machine'); $symbolCache=[Environment]::GetEnvironmentVariable('_NT_ALT_SYMBOL_PATH','Machine'); $symbolWritable=$false; if(-not [string]::IsNullOrWhiteSpace($symbolCache)){try{New-Item -ItemType Directory -Force -Path $symbolCache|Out-Null; $probe=Join-Path $symbolCache 'crucible-symbol-cache.probe'; Set-Content -LiteralPath $probe -Value ok -Force; Remove-Item -LiteralPath $probe -Force; $symbolWritable=$true}catch{$symbolWritable=$false}}; $sys=[ordered]@{handle=Find-Tool @('handle64.exe','handle.exe'); strings=Find-Tool @('strings64.exe','strings.exe'); tcpview=Find-Tool @('Tcpview.exe','Tcpview64.exe'); tcpvcon=Find-Tool @('tcpvcon64.exe','tcpvcon.exe'); procdump=Find-Tool @('procdump64.exe','procdump.exe'); procmon=Find-Tool @('Procmon64.exe','Procmon.exe','procmon64.exe','procmon.exe'); listdlls=Find-Tool @('Listdlls64.exe','Listdlls.exe'); autorunsc=Find-Tool @('autorunsc64.exe','autorunsc.exe'); sigcheck=Find-Tool @('sigcheck64.exe','sigcheck.exe')}; $admin=Test-User $adminUsername; $user=Test-User $standardUsername; $qga=ServiceStatus 'qemu-ga'; $agent=ServiceStatus 'CrucibleGuestAgent'; $def=DefenderRtp; $vbs=DwordValue 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard' 'EnableVirtualizationBasedSecurity'; $hvci=DwordValue 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity' 'Enabled'; $ciRecorded=($null -ne $vbs -and $null -ne $hvci); $ciDisabled=($vbs -eq 0 -and $hvci -eq 0); $bootOptions=@(CodeIntegrityBootOptions); $ts=TestSigning;
[ordered]@{cdbPath=$cdb; windbgPath=$windbg; kdPath=$kd; kdnetPath=$kdnet; gflagsPath=$gflags; symbolPath=$symbol; symbolCachePath=$symbolCache; symbolCacheWritable=$symbolWritable; sysinternals=$sys; adminUsername=$adminUsername; standardUsername=$standardUsername; crucibleAdminPresent=$admin; crucibleUserPresent=$user; qemuAgentStatus=$qga; crucibleAgentStatus=$agent; defenderRealTimeProtectionEnabled=$def; codeIntegrityStateRecorded=[bool]$ciRecorded; codeIntegrityEnforcementDisabled=[bool]$ciDisabled; hypervisorEnforcedCodeIntegrityDisabled=[bool]($hvci -eq 0); codeIntegrityBootOptions=@($bootOptions); testSigningEnabled=$ts; healthy=($admin -and $user -and $qga -eq 'Running' -and $agent -eq 'Running' -and $ciRecorded -and $ciDisabled -and $ts -eq $false -and $null -ne $cdb -and $null -ne $windbg -and $null -ne $kd -and $null -ne $kdnet -and $null -ne $gflags -and $symbolWritable)} | ConvertTo-Json -Compress`;
}

function powerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function renderSnapshotCreateResult(result: SnapshotCreateResult): string {
  return [
    `Snapshot created: ${result.snapshot.name}`,
    `clean: ${result.snapshot.clean ? "yes" : "no"}`,
    `mode: ${result.snapshot.mode ?? "unknown"}`,
    `base disk: ${result.snapshot.baseDiskPath}`,
    `snapshot artifact path: ${result.snapshot.path}`,
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

async function fetchToolsCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CommandResult> {
  const parsed = parseFetchToolsArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }
  const config = getRuntimeConfig(runtime);
  const results = await fetchToolArchives(config.media.cacheDir, parsed.args);
  return { exitCode: 0, stdout: renderFetchToolsResult(results), stderr: "" };
}

async function initConfigCommand(args: readonly string[]): Promise<CommandResult> {
  const parsed = parseConfigInitArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const outputPath = resolvePath(parsed.args.outputPath);
  if (!parsed.args.force && (await fileExists(outputPath))) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${parsed.args.outputPath} already exists; pass --force to overwrite`,
    };
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${getExampleConfigJson()}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    exitCode: 0,
    stdout: [
      `Wrote ${parsed.args.outputPath}`,
      "Edit media.windowsIso.path and media.virtioIso.path before provisioning.",
    ].join("\n"),
    stderr: "",
  };
}

async function doctorCommand(args: readonly string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown doctor option: ${args[0]}` };
  }
  const result = await runHostCheck();
  return {
    exitCode: result.healthy ? 0 : 1,
    stdout: [
      `Host: ${result.platform}/${result.arch}`,
      `Status: ${result.healthy ? "healthy" : "missing prerequisites"}`,
      result.missing.length > 0 ? `Missing: ${result.missing.join(", ")}` : "Missing: none",
      `Notes: ${result.notes ?? "none"}`,
      ...(!result.healthy && result.platform === "linux"
        ? ["", "Manual install (Debian/Ubuntu):", getAptInstallCommand()]
        : []),
      ...(!result.healthy && result.platform !== "linux"
        ? ["", "Crucible currently supports Linux/KVM hosts only."]
        : []),
    ].join("\n"),
    stderr: "",
  };
}

async function setupCommand(args: readonly string[], runtime: CliRuntime): Promise<CommandResult> {
  const parsed = parseSetupArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  if (parsed.args.target === "all") {
    const targets: SetupTarget[] = ["host", "opencode", "claude", "codex", "copilot"];
    const results: string[] = [];
    let exitCode = 0;
    for (const target of targets) {
      const result = await setupCommand([target, ...setupFlags(parsed.args)], runtime);
      if (exitCode === 0 && result.exitCode !== 0) exitCode = result.exitCode;
      results.push(`## ${target}`, [result.stdout, result.stderr].filter(Boolean).join("\n"));
    }
    return { exitCode, stdout: results.join("\n\n"), stderr: "" };
  }

  switch (parsed.args.target) {
    case "host":
      return setupHostCommand(parsed.args);
    case "opencode":
      return setupJsonMcpCommand({
        targetName: "opencode",
        configPath: join(homedir(), ".config", "opencode", "opencode.json"),
        mcpKey: "mcp",
        printOnly: parsed.args.printOnly,
        mode: "setup",
      });
    case "claude":
      return setupClaudeCommand(parsed.args.printOnly);
    case "codex":
      return renderSetupInstruction(
        "codex",
        [
          "Codex stores MCP servers in `~/.codex/config.toml` or a trusted project `.codex/config.toml`.",
          "CLI:",
          "codex mcp add crucible -- crucible mcp --stdio",
          "",
          "TOML:",
          '[mcp_servers.crucible]\ncommand = "crucible"\nargs = ["mcp", "--stdio"]\nenabled = true',
        ].join("\n"),
      );
    case "copilot":
      return renderSetupInstruction(
        "copilot",
        [
          "Copilot CLI stores MCP servers in `~/.copilot/mcp-config.json`.",
          "In Copilot CLI, run `/mcp add`, choose Local/STDIO, and use command `crucible mcp --stdio`.",
          "",
          "JSON:",
          JSON.stringify(
            {
              mcpServers: {
                crucible: {
                  type: "local",
                  command: "crucible",
                  args: ["mcp", "--stdio"],
                  env: {},
                },
              },
            },
            null,
            2,
          ),
          "",
          "Copilot cloud agent/code review repository settings also use an `mcpServers` JSON object, but that configuration is managed on GitHub.com and should add only the tool names you intend to expose.",
        ].join("\n"),
      );
  }
}

async function updateCommand(args: readonly string[], runtime: CliRuntime): Promise<CommandResult> {
  const parsed = parseUpdateArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  const runner = runtime.processRunner ?? nodeProcessRunner;
  let latestResult: ProcessResult;
  try {
    latestResult = await runner.run({
      executable: "npm",
      args: ["view", "@adamkadaban/crucible", "version", "--silent"],
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
    });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        "Failed to check npm for the latest Crucible version.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    };
  }
  if (latestResult.exitCode !== 0 || latestResult.timedOut) {
    return {
      exitCode: latestResult.timedOut ? 1 : (latestResult.exitCode ?? 1),
      stdout: "",
      stderr: [`Failed to check npm for the latest Crucible version.`, latestResult.stderr]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const latestVersion = latestResult.stdout.trim();
  if (latestVersion.length === 0) {
    return { exitCode: 1, stdout: "", stderr: "npm did not report a latest Crucible version." };
  }

  const actions: string[] = [
    "Crucible update plan:",
    `current version: ${CRUCIBLE_VERSION}`,
    `latest npm version: ${latestVersion}`,
  ];
  const needsPackageUpdate = latestVersion !== CRUCIBLE_VERSION;

  if (!needsPackageUpdate && !parsed.args.dryRun) {
    actions.push("package update: already current");
    return { exitCode: 0, stdout: actions.join("\n"), stderr: "" };
  }

  const install = await detectGlobalInstall(runner);
  actions.push(`detected install: ${formatInstallDetection(install)}`);

  if (parsed.args.dryRun) {
    actions.push(
      `package update: ${needsPackageUpdate ? "would run" : "already current"}`,
      `package command: ${formatCommand(buildPackageUpdateCommand(install))}`,
      "MCP config refresh:",
      ...(await renderMcpUpdateDryRun()),
    );
    return { exitCode: 0, stdout: actions.join("\n"), stderr: "" };
  }

  if (!parsed.args.yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return {
      exitCode: 1,
      stdout: actions.join("\n"),
      stderr: "Non-interactive update requires --yes.",
    };
  }

  if (!parsed.args.yes) {
    const confirmed = await confirmYes("Update Crucible and refresh MCP config? [Y/n] ");
    if (!confirmed) {
      return { exitCode: 1, stdout: actions.join("\n"), stderr: "Update cancelled." };
    }
  }

  const command = buildPackageUpdateCommand(install);
  let updateResult: ProcessResult;
  actions.push(`package command: ${formatCommand(command)}`);
  try {
    updateResult = await runner.run({
      executable: command[0] ?? "npm",
      args: command.slice(1),
      timeoutMs: 5 * 60 * 1000,
      maxOutputBytes: 1024 * 1024,
    });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: actions.join("\n"),
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  if (updateResult.exitCode !== 0 || updateResult.timedOut) {
    return {
      exitCode: updateResult.timedOut ? 1 : (updateResult.exitCode ?? 1),
      stdout: actions.join("\n"),
      stderr: updateResult.stderr,
    };
  }
  actions.push("package update: completed");

  const mcpResults = await refreshMcpConfigs();
  actions.push("MCP config refresh:", ...mcpResults.lines);
  return { exitCode: mcpResults.exitCode, stdout: actions.join("\n"), stderr: mcpResults.stderr };
}

type GlobalInstallDetection = {
  readonly manager: "npm" | "pnpm";
  readonly detail: string;
};

async function detectGlobalInstall(runner: ProcessRunner): Promise<GlobalInstallDetection> {
  const [npmRoot, pnpmRoot] = await Promise.all([
    readGlobalRoot(runner, "npm"),
    readGlobalRoot(runner, "pnpm"),
  ]);

  if (pnpmRoot !== undefined && (await packageExistsInGlobalRoot(pnpmRoot))) {
    return { manager: "pnpm", detail: pnpmRoot };
  }
  if (npmRoot !== undefined && (await packageExistsInGlobalRoot(npmRoot))) {
    return { manager: "npm", detail: npmRoot };
  }
  if (npmRoot !== undefined) {
    return { manager: "npm", detail: `${npmRoot} (package not found; fallback)` };
  }
  if (pnpmRoot !== undefined) {
    return { manager: "pnpm", detail: `${pnpmRoot} (package not found; fallback)` };
  }

  return { manager: "npm", detail: "fallback" };
}

async function readGlobalRoot(
  runner: ProcessRunner,
  manager: "npm" | "pnpm",
): Promise<string | undefined> {
  let result: ProcessResult;
  try {
    result = await runner.run({
      executable: manager,
      args: ["root", "-g"],
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    });
  } catch {
    return undefined;
  }
  const root = result.stdout.trim();
  return result.exitCode === 0 && root.length > 0 ? root : undefined;
}

function packageExistsInGlobalRoot(root: string): Promise<boolean> {
  return fileExists(join(root, "@adamkadaban", "crucible", "package.json"));
}

function formatInstallDetection(install: GlobalInstallDetection): string {
  return `${install.manager} global (${install.detail})`;
}

function buildPackageUpdateCommand(install: GlobalInstallDetection): readonly string[] {
  if (install.manager === "pnpm") {
    return ["pnpm", "add", "-g", "@adamkadaban/crucible@latest"];
  }
  return ["npm", "install", "-g", "@adamkadaban/crucible@latest"];
}

async function renderMcpUpdateDryRun(): Promise<readonly string[]> {
  const opencodePath = join(homedir(), ".config", "opencode", "opencode.json");
  const opencodeStatus = await describeJsonMcpUpdateDryRun(opencodePath, "mcp");
  return [
    `- opencode: ${opencodeStatus}: ${opencodePath}`,
    "- claude: would skip; run `crucible setup claude` to refresh via Claude CLI",
    "- codex: would skip; run `crucible setup codex --print` for current guidance",
    "- copilot: would skip; run `crucible setup copilot --print` for current guidance",
  ];
}

async function describeJsonMcpUpdateDryRun(configPath: string, mcpKey: string): Promise<string> {
  try {
    const config = await readJsonObjectIfExists(configPath);
    const existing = config[mcpKey];
    if (existing !== undefined && !isJsonObject(existing)) {
      return `would fail; expected ${configPath}.${mcpKey} to be an object`;
    }
    const previousEntry = existing === undefined ? undefined : existing.crucible;
    return jsonValuesEqual(previousEntry, getMcpServerEntry())
      ? "already current"
      : "would refresh";
  } catch (error) {
    return `would fail; ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function refreshMcpConfigs(): Promise<{
  readonly exitCode: number;
  readonly lines: readonly string[];
  readonly stderr: string;
}> {
  const results: string[] = [];
  const opencode = await setupJsonMcpCommand({
    targetName: "opencode",
    configPath: join(homedir(), ".config", "opencode", "opencode.json"),
    mcpKey: "mcp",
    printOnly: false,
    mode: "update",
  });
  results.push(
    `- opencode: ${firstLine([opencode.stdout, opencode.stderr].filter(Boolean).join(" "))}`,
  );

  results.push("- claude: skipped; run `crucible setup claude` to refresh via Claude CLI");
  results.push("- codex: skipped; run `crucible setup codex --print` for current guidance");
  results.push("- copilot: skipped; run `crucible setup copilot --print` for current guidance");
  return { exitCode: opencode.exitCode, lines: results, stderr: opencode.stderr };
}

function firstLine(value: string): string {
  const line = value.split("\n").find((candidate) => candidate.trim().length > 0);
  return line ?? "no output";
}

function versionCommand(args: readonly string[]): CommandResult {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown version option: ${args[0]}` };
  }
  return { exitCode: 0, stdout: CRUCIBLE_VERSION, stderr: "" };
}

function setupFlags(args: SetupArgs): string[] {
  return [args.printOnly ? "--print" : undefined, args.yes ? "--yes" : undefined].filter(
    (value): value is string => value !== undefined,
  );
}

async function setupHostCommand(args: SetupArgs): Promise<CommandResult> {
  const result = await runHostCheck();
  if (result.healthy) {
    return { exitCode: 0, stdout: "Host prerequisites are already satisfied.", stderr: "" };
  }
  const installCommand = getAptInstallCommand(false);
  const executedCommand = getAptInstallCommand(true);
  if (result.platform !== "linux") {
    return {
      exitCode: 1,
      stdout: `Missing: ${result.missing.join(", ")}`,
      stderr: "Automatic host dependency installation is supported only on Linux.",
    };
  }
  if (args.printOnly) {
    return {
      exitCode: 0,
      stdout: [`Missing: ${result.missing.join(", ")}`, `Install command: ${installCommand}`].join(
        "\n",
      ),
      stderr: "",
    };
  }

  if (!args.yes) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const confirmed = await confirmYes(
        `Missing: ${result.missing.join(", ")}\nRun ${executedCommand}? [Y/n] `,
      );
      if (confirmed) {
        return runHostInstallCommand(executedCommand);
      }
    }
    return {
      exitCode: 1,
      stdout: [
        `Missing: ${result.missing.join(", ")}`,
        `Install command: ${installCommand}`,
        "Re-run with --yes to execute this command, or install manually.",
      ].join("\n"),
      stderr: "",
    };
  }

  return runHostInstallCommand(executedCommand);
}

async function runHostInstallCommand(command: string): Promise<CommandResult> {
  const install = await runHostCommand("sudo", ["apt", "install", "-y", ...APT_PACKAGES]);
  return {
    exitCode: install.exitCode,
    stdout: [`Ran: ${command}`, install.stdout].filter(Boolean).join("\n"),
    stderr: install.stderr,
  };
}

async function confirmYes(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

const APT_PACKAGES = ["qemu-system-x86", "qemu-utils", "ovmf", "swtpm", "socat", "xorriso"];

function getAptInstallCommand(includeYes = false): string {
  return `sudo apt install${includeYes ? " -y" : ""} ${APT_PACKAGES.join(" ")}`;
}

function runHostCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: [process.stdin.isTTY ? "inherit" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => resolve({ exitCode: 1, stdout, stderr: error.message }));
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function setupClaudeCommand(printOnly: boolean): Promise<CommandResult> {
  const json = JSON.stringify(getClaudeMcpServerEntry(), null, 2);
  if (printOnly) {
    return {
      exitCode: 0,
      stdout: `claude mcp add --transport stdio --scope user crucible -- crucible mcp --stdio\n\nJSON:\n${json}`,
      stderr: "",
    };
  }
  const result = await runHostCommand("claude", [
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    "user",
    "crucible",
    "--",
    "crucible",
    "mcp",
    "--stdio",
  ]);
  const prefix =
    result.exitCode === 0
      ? "Updated Claude Code MCP config via claude CLI."
      : "Failed to update Claude Code MCP config via claude CLI.";
  return {
    exitCode: result.exitCode,
    stdout: [prefix, result.stdout].filter(Boolean).join("\n"),
    stderr: result.stderr,
  };
}

async function setupJsonMcpCommand(options: {
  readonly targetName: string;
  readonly configPath: string;
  readonly mcpKey: string;
  readonly printOnly: boolean;
  readonly mode?: "setup" | "update";
}): Promise<CommandResult> {
  const entry = getMcpServerEntry();
  if (options.printOnly) {
    return {
      exitCode: 0,
      stdout: `${options.configPath}\n${JSON.stringify({ [options.mcpKey]: { crucible: entry } }, null, 2)}`,
      stderr: "",
    };
  }

  let config: JsonObject;
  try {
    config = await readJsonObjectIfExists(options.configPath);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Failed to read ${options.configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const currentMcp = config[options.mcpKey];
  if (currentMcp !== undefined && !isJsonObject(currentMcp)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Expected ${options.configPath}.${options.mcpKey} to contain a JSON object`,
    };
  }
  const existing: JsonObject = currentMcp ?? {};
  const previousEntry = existing.crucible;
  const changed = !jsonValuesEqual(previousEntry, entry);
  config[options.mcpKey] = { ...existing, crucible: entry };
  if (options.mode === "update" && !changed) {
    return {
      exitCode: 0,
      stdout: `${options.targetName} config already current: ${options.configPath}`,
      stderr: "",
    };
  }
  let backupPath: string | undefined;
  try {
    backupPath = await writeJsonConfigWithBackup(options.configPath, config);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Failed to write ${options.configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const verb = options.mode === "update" ? "Refreshed" : "Updated";
  const lines = [`${verb} ${options.targetName} config: ${options.configPath}`];
  if (backupPath !== undefined) {
    lines.push(`Backup: ${backupPath}`);
  }
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}

function getMcpServerEntry(): JsonObject {
  return { enabled: true, type: "local", command: ["crucible", "mcp", "--stdio"] };
}

function getClaudeMcpServerEntry(): JsonObject {
  return { type: "stdio", command: "crucible", args: ["mcp", "--stdio"], env: {} };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJsonValue(nested)]),
    );
  }
  return value;
}

function renderSetupInstruction(target: string, message: string): CommandResult {
  return { exitCode: 0, stdout: `${target}: ${message}`, stderr: "" };
}

async function readJsonObjectIfExists(filePath: string): Promise<JsonObject> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isJsonObject(value)) {
      throw new Error(`Expected ${filePath} to contain a JSON object`);
    }
    return value;
  } catch (error) {
    if (isMissingPathError(error)) {
      return {};
    }
    throw error;
  }
}

async function writeJsonConfigWithBackup(
  filePath: string,
  config: JsonObject,
): Promise<string | undefined> {
  await mkdir(dirname(filePath), { recursive: true });
  let backupPath: string | undefined;
  if (await fileExists(filePath)) {
    backupPath = await nextBackupPath(filePath);
    await copyFile(filePath, backupPath);
  }
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, filePath);
  return backupPath;
}

async function nextBackupPath(filePath: string): Promise<string> {
  const stamp = Date.now();
  for (let index = 0; index < 1000; index += 1) {
    const candidate = `${filePath}.bak.${stamp}${index === 0 ? "" : `.${index}`}`;
    if (!(await fileExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to allocate backup path for ${filePath}`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function renderNetStatusCommand(args: readonly string[], runtime: CliRuntime): CommandResult {
  if (args.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `Unknown network status option: ${args[0]}` };
  }
  const config = getRuntimeConfig(runtime);
  const plan = buildNetworkPlan({
    config: config.network,
    networkDevice: config.virtio.networkDevice,
    vmName: config.vm.name,
  });
  return {
    exitCode: 0,
    stdout: renderNetworkRuntimeStatus(buildNetworkRuntimeStatus(plan)),
    stderr: "",
  };
}

function renderNetSetCommand(args: readonly string[], runtime: CliRuntime): CommandResult {
  const requestedMode = args[0];
  if (args.length !== 1 || requestedMode === undefined || !isNetworkMode(requestedMode)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "net:set requires one mode: isolated, nat, or capture",
    };
  }
  const config = getRuntimeConfig(runtime);
  const current = buildNetworkPlan({
    config: config.network,
    networkDevice: config.virtio.networkDevice,
    vmName: config.vm.name,
  });
  const requested = buildNetworkPlan({
    config: { ...config.network, mode: requestedMode },
    networkDevice: config.virtio.networkDevice,
    vmName: config.vm.name,
  });
  return {
    exitCode: 0,
    stdout: renderNetworkModeChange(buildNetworkModeChangePlan({ current, requested })),
    stderr: "",
  };
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

function renderNetworkRuntimeStatus(status: ReturnType<typeof buildNetworkRuntimeStatus>): string {
  return [
    `Network status: ${status.configuredMode}`,
    `backend: ${status.backend}`,
    `guest address: ${status.guestAddress}`,
    `host address: ${status.hostAddress}`,
    `control port: ${status.controlPort}`,
    `guest egress: ${status.guestEgress}`,
    `live switch supported: ${status.liveSwitchSupported ? "yes" : "no"}`,
    `restart required to change mode: ${status.restartRequiredToChangeMode ? "yes" : "no"}`,
    ...status.warnings.map((warning) => `warning: ${warning}`),
  ].join("\n");
}

function renderNetworkModeChange(change: ReturnType<typeof buildNetworkModeChangePlan>): string {
  return [
    `Network mode change: ${change.currentMode} -> ${change.requestedMode}`,
    `applied live: ${change.appliedLive ? "yes" : "no"}`,
    `restart required: ${change.restartRequired ? "yes" : "no"}`,
    `reason: ${change.reason}`,
    "QEMU args preview:",
    ...change.qemuArgsPreview.map((arg) => `- ${arg}`),
  ].join("\n");
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
    lines.push(
      "",
      getManualDownloadInstructions(plan.cacheDirectory, plan.manualDownloads),
      "",
      "Optional tool archives:",
      ...TOOL_ARCHIVES.map(
        (archive) =>
          `- ${archive.name}: ${archive.url} -> ${resolvePath(plan.cacheDirectory, archive.fileName)}`,
      ),
    );
  } else {
    lines.push(
      "",
      "Manual download instructions are hidden by default; pass --manual to include profile-specific links.",
    );
  }

  return lines.join("\n");
}

type ToolArchive = {
  readonly name: string;
  readonly url: string;
  readonly fileName: string;
};

type ToolFetchResult = {
  readonly name: string;
  readonly url: string;
  readonly path: string;
  readonly status: "downloaded" | "cached";
  readonly sizeBytes: number;
  readonly sha256: string;
};

const TOOL_ARCHIVES: readonly ToolArchive[] = [
  {
    name: "Sysinternals Suite",
    url: "https://download.sysinternals.com/files/SysinternalsSuite.zip",
    fileName: "SysinternalsSuite.zip",
  },
  {
    name: "ProcDump",
    url: "https://download.sysinternals.com/files/Procdump.zip",
    fileName: "Procdump.zip",
  },
  {
    name: "Process Monitor",
    url: "https://download.sysinternals.com/files/ProcessMonitor.zip",
    fileName: "ProcessMonitor.zip",
  },
];

async function fetchToolArchives(
  cacheDirectory: string,
  args: FetchToolsArgs,
): Promise<readonly ToolFetchResult[]> {
  await mkdir(cacheDirectory, { recursive: true });
  const results: ToolFetchResult[] = [];
  for (const archive of TOOL_ARCHIVES) {
    const destination = resolvePath(cacheDirectory, archive.fileName);
    if (!args.force && (await fileExists(destination))) {
      const data = await readFile(destination);
      results.push({
        name: archive.name,
        url: archive.url,
        path: destination,
        status: "cached",
        sizeBytes: data.byteLength,
        sha256: sha256Hex(data),
      });
      continue;
    }
    const response = await fetch(archive.url);
    if (!response.ok) {
      throw new Error(`download ${archive.url} failed: HTTP ${response.status}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data, { mode: 0o644 });
    results.push({
      name: archive.name,
      url: archive.url,
      path: destination,
      status: "downloaded",
      sizeBytes: data.byteLength,
      sha256: sha256Hex(data),
    });
  }
  return results;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function renderFetchToolsResult(results: readonly ToolFetchResult[]): string {
  return [
    "Fetched tool archives:",
    ...results.map(
      (result) =>
        `- ${result.name}: ${result.status}, ${result.sizeBytes} bytes, sha256=${result.sha256}, path=${result.path}`,
    ),
  ].join("\n");
}

type MediaPlanArgsResult =
  | { readonly ok: true; readonly args: MediaPlanArgs }
  | { readonly ok: false; readonly message: string };

type FetchToolsArgsResult =
  | { readonly ok: true; readonly args: FetchToolsArgs }
  | { readonly ok: false; readonly message: string };

type NetPlanArgsResult =
  | { readonly ok: true; readonly args: NetPlanArgs }
  | { readonly ok: false; readonly message: string };

type NetTeardownArgsResult =
  | { readonly ok: true; readonly args: NetTeardownArgs }
  | { readonly ok: false; readonly message: string };

function parseVmViewArgs(args: readonly string[]): VmViewArgsResult {
  let dryRun = false;
  let viewer: "remote-viewer" | "vncviewer" = "remote-viewer";
  let host = "127.0.0.1";
  let display = 1;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--viewer") {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: "Missing value for --viewer" };
      }
      if (value !== "remote-viewer" && value !== "vncviewer") {
        return { ok: false, message: "--viewer must be remote-viewer or vncviewer" };
      }
      viewer = value;
      index += 1;
      continue;
    }
    if (arg === "--host") {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: "Missing value for --host" };
      }
      if (value !== "127.0.0.1" && value !== "localhost") {
        return { ok: false, message: "vm view only supports loopback hosts" };
      }
      host = "127.0.0.1";
      index += 1;
      continue;
    }
    if (arg === "--display") {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: "Missing value for --display" };
      }
      if (!/^\d+$/.test(value)) {
        return { ok: false, message: "--display must be an integer from 0 to 99" };
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 99) {
        return { ok: false, message: "--display must be an integer from 0 to 99" };
      }
      display = parsed;
      index += 1;
      continue;
    }
    return { ok: false, message: `Unknown vm view option: ${arg}` };
  }

  return { ok: true, args: { dryRun, viewer, host, display } };
}

function buildVmViewCommand(args: VmViewArgs, port: number): readonly string[] {
  if (args.viewer === "vncviewer") {
    return ["vncviewer", `${args.host}:${args.display}`];
  }
  return ["remote-viewer", `vnc://${args.host}:${port}`];
}

type GuestExecArgsResult =
  | { readonly ok: true; readonly args: GuestExecArgs }
  | { readonly ok: false; readonly message: string };

type DebugSmokeArgsResult =
  | { readonly ok: true; readonly executable: string }
  | { readonly ok: false; readonly message: string };

type SnapshotNameArgsResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string };

function parseSnapshotNameArgs(args: readonly string[], command: string): SnapshotNameArgsResult {
  if (args.length === 0) {
    return { ok: true, name: "clean-base" };
  }

  const [candidate] = args;
  if (args.length === 1 && candidate !== undefined && !candidate.startsWith("-")) {
    try {
      return { ok: true, name: normalizeSnapshotName(candidate) };
    } catch (error) {
      if (error instanceof CrucibleError && error.code === "CONFIG_INVALID") {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  return { ok: false, message: `${command} accepts at most one snapshot name` };
}

function parseGuestExecArgs(args: readonly string[]): GuestExecArgsResult {
  let as: GuestExecArgs["as"] = "service";
  const command: string[] = [];
  let sawSeparator = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      sawSeparator = true;
      command.push(...args.slice(index + 1));
      break;
    }

    if (command.length === 0 && arg === "--as") {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: "Missing value for --as" };
      }
      if (!isGuestExecPrincipal(value)) {
        return { ok: false, message: `Unknown guest execution principal: ${value}` };
      }
      as = value;
      index += 1;
      continue;
    }

    command.push(arg ?? "");
  }

  if (
    !sawSeparator &&
    command.length === 3 &&
    command[0] !== undefined &&
    command[1] === "--as" &&
    isGuestExecPrincipal(command[2])
  ) {
    as = command[2];
    command.splice(1, 2);
  }

  const [executable, ...commandArgs] = command;
  if (executable === undefined || executable.length === 0) {
    return { ok: false, message: "guest:exec requires an executable" };
  }

  if (commandArgs.length === 0 && /\s/.test(executable)) {
    return {
      ok: true,
      args: { executable: "cmd.exe", arguments: ["/d", "/s", "/c", executable], as },
    };
  }

  return { ok: true, args: { executable, arguments: commandArgs, as } };
}

function isGuestExecPrincipal(value: string | undefined): value is GuestExecArgs["as"] {
  return value === "service" || value === "standard" || value === "admin";
}

function parseDebugSmokeArgs(args: readonly string[]): DebugSmokeArgsResult {
  let executable: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--exe") {
      return { ok: false, message: `Unknown debug:smoke option: ${arg}` };
    }
    const value = args[index + 1];
    if (value === undefined) {
      return { ok: false, message: "Missing value for --exe" };
    }
    executable = value;
    index += 1;
  }
  if (executable === undefined || executable.length === 0) {
    return { ok: false, message: "debug:smoke requires --exe <guest-executable>" };
  }
  return { ok: true, executable };
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

    return { ok: false, message: `Unknown network plan option: ${arg}` };
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

    return { ok: false, message: `Unknown network teardown option: ${arg}` };
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

function parseFetchToolsArgs(args: readonly string[]): FetchToolsArgsResult {
  let force = false;
  for (const arg of args) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    return { ok: false, message: `Unknown media:fetch-tools option: ${arg}` };
  }
  return { ok: true, args: { force } };
}

function parseConfigInitArgs(args: readonly string[]): ConfigInitArgsResult {
  let outputPath = getDefaultCrucibleConfigPath();
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--output") {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: "Missing value for --output" };
      }
      outputPath = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `Unknown config init option: ${arg}` };
  }

  return { ok: true, args: { outputPath, force } };
}

function parseSetupArgs(args: readonly string[]): SetupArgsResult {
  const target = args[0];
  if (!isSetupTarget(target)) {
    return {
      ok: false,
      message: "setup requires one target: host, opencode, claude, codex, copilot, or all",
    };
  }

  let printOnly = false;
  let yes = false;
  for (const arg of args.slice(1)) {
    if (arg === "--print") {
      printOnly = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    return { ok: false, message: `Unknown setup option: ${arg}` };
  }

  return { ok: true, args: { target, printOnly, yes } };
}

function parseUpdateArgs(args: readonly string[]): UpdateArgsResult {
  let dryRun = false;
  let yes = false;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    return { ok: false, message: `Unknown update option: ${arg}` };
  }

  return { ok: true, args: { dryRun, yes } };
}

function isSetupTarget(value: string | undefined): value is SetupTarget {
  return (
    value === "host" ||
    value === "opencode" ||
    value === "claude" ||
    value === "codex" ||
    value === "copilot" ||
    value === "all"
  );
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
  return `  - ${tool.name}: ${tool.description}`;
}

function buildEnvGuestClientFactory():
  | (() => Promise<import("@crucible/core").GuestAgentClient>)
  | undefined {
  const baseUrl = process.env.CRUCIBLE_GUEST_BASE_URL;
  const caPath = process.env.CRUCIBLE_GUEST_CA_PATH;
  const certPath = process.env.CRUCIBLE_GUEST_CERT_PATH;
  const keyPath = process.env.CRUCIBLE_GUEST_KEY_PATH;
  if (
    baseUrl === undefined ||
    caPath === undefined ||
    certPath === undefined ||
    keyPath === undefined
  ) {
    return undefined;
  }
  return cacheGuestClientFactory(() =>
    buildGuestAgentClientFromFiles({
      baseUrl,
      caPath,
      clientCertificatePath: certPath,
      clientPrivateKeyPath: keyPath,
    }),
  );
}

export function buildDefaultGuestClientFactory(
  config: CrucibleConfig,
): (() => Promise<CliGuestHealthClient>) | undefined {
  const envFactory = buildEnvGuestClientFactory();
  if (envFactory !== undefined) {
    return envFactory;
  }

  const mtlsDirectory = resolvePath(config.artifacts.secretsDirectory, config.vm.name, "mtls");
  return () =>
    buildGuestAgentClientFromFiles({
      baseUrl: `https://127.0.0.1:${config.network.controlPort}`,
      caPath: resolvePath(mtlsDirectory, "ca.cert.pem"),
      clientCertificatePath: resolvePath(mtlsDirectory, "host-client.cert.pem"),
      clientPrivateKeyPath: resolvePath(mtlsDirectory, "host-client.key.pem"),
      timeoutMs: 60_000,
    });
}

function hasExplicitGuestClientEnv(): boolean {
  return (
    process.env.CRUCIBLE_GUEST_BASE_URL !== undefined ||
    process.env.CRUCIBLE_GUEST_CA_PATH !== undefined ||
    process.env.CRUCIBLE_GUEST_CERT_PATH !== undefined ||
    process.env.CRUCIBLE_GUEST_KEY_PATH !== undefined
  );
}

const COMMAND_GROUPS: readonly CommandGroupDefinition[] = [
  { name: "config", summary: "Create and inspect Crucible configuration." },
  { name: "media", summary: "Plan local Windows, virtio, and tool media." },
  { name: "vm", summary: "Create, start, stop, and inspect the analysis VM." },
  { name: "snapshot", summary: "Create, list, and restore VM snapshots." },
  { name: "network", aliases: ["net"], summary: "Preview and switch VM network modes." },
  { name: "guest", summary: "Check or run commands through the Windows guest agent." },
  { name: "debug", summary: "Run debugger smoke checks." },
  { name: "scenario", summary: "Run canned analysis workflows." },
];

const COMMANDS: readonly CommandDefinition[] = [
  {
    canonical: "config:init",
    preferred: "config init",
    group: "config",
    summary: "Write an example global config file.",
    usage: ["crucible config init [--output ~/.config/crucible/config.json] [--force]"],
    examples: ["crucible config init", "crucible config init --force"],
  },
  {
    canonical: "doctor",
    preferred: "doctor",
    summary: "Check host prerequisites.",
    usage: ["crucible doctor"],
  },
  {
    canonical: "setup",
    preferred: "setup",
    summary: "Install host prerequisites or configure MCP clients.",
    usage: ["crucible setup host|opencode|claude|codex|copilot|all [--print] [--yes]"],
    examples: ["crucible setup host --print", "crucible setup opencode"],
  },
  {
    canonical: "version",
    preferred: "version",
    summary: "Print the Crucible CLI version.",
    usage: ["crucible version"],
  },
  {
    canonical: "update",
    preferred: "update",
    summary: "Update the global package and refresh MCP config entries.",
    usage: ["crucible update [--dry-run] [--yes]"],
    examples: ["crucible update --dry-run", "crucible update --yes"],
  },
  {
    canonical: "provision",
    preferred: "provision",
    summary: "Provision a Windows analysis VM and clean baseline snapshot.",
    usage: ["crucible provision"],
  },
  {
    canonical: "mcp",
    preferred: "mcp",
    summary: "Print MCP server info or run the stdio MCP server.",
    usage: ["crucible mcp", "crucible mcp --stdio"],
  },
  {
    canonical: "package",
    preferred: "package",
    summary: "Build release package artifacts from a source checkout.",
    usage: ["crucible package"],
  },
  {
    canonical: "media:plan",
    preferred: "media plan",
    group: "media",
    summary: "Print required media and optional manual download links.",
    usage: [
      "crucible media plan [--manual] [--profile windows11-enterprise-eval|windows-server-2025-eval]",
    ],
    examples: ["crucible media plan --manual"],
  },
  {
    canonical: "media:fetch-tools",
    preferred: "media fetch-tools",
    group: "media",
    summary: "Download optional tool archives into the media cache.",
    usage: ["crucible media fetch-tools [--force]"],
  },
  {
    canonical: "vm:create",
    preferred: "vm create",
    group: "vm",
    summary: "Print the planned qcow2 creation and QEMU inputs.",
    usage: ["crucible vm create --dry-run"],
  },
  {
    canonical: "vm:start",
    preferred: "vm start",
    group: "vm",
    summary: "Start the VM, or print the planned QEMU argv.",
    usage: ["crucible vm start [--dry-run]"],
    examples: ["crucible vm start --dry-run", "crucible vm start"],
  },
  {
    canonical: "vm:stop",
    preferred: "vm stop",
    group: "vm",
    summary: "Request graceful VM shutdown, ACPI poweroff, or kill fallback.",
    usage: ["crucible vm stop [--poweroff|--kill]"],
  },
  {
    canonical: "vm:status",
    preferred: "vm status",
    group: "vm",
    summary: "Show lifecycle, PID, QMP, and log paths.",
    usage: ["crucible vm status"],
  },
  {
    canonical: "vm:credentials",
    preferred: "vm credentials",
    group: "vm",
    summary: "Print generated Windows account usernames and passwords.",
    usage: ["crucible vm credentials"],
  },
  {
    canonical: "vm:paste",
    preferred: "vm paste",
    group: "vm",
    summary: "Paste text into the focused VM window via QMP keyboard input.",
    usage: ["crucible vm paste (--text value|--stdin) [--delay-ms 0]"],
    examples: ['printf %s "$VM_PASSWORD" | crucible vm paste --stdin'],
  },
  {
    canonical: "vm:view",
    preferred: "vm view",
    group: "vm",
    summary: "Open a loopback-only VNC view of the running VM.",
    usage: [
      "crucible vm view [--dry-run] [--viewer remote-viewer|vncviewer] [--host 127.0.0.1|localhost] [--display 1]",
    ],
    examples: ["crucible vm view --dry-run", "crucible vm view --viewer remote-viewer"],
  },
  {
    canonical: "vm:logs",
    preferred: "vm logs",
    group: "vm",
    summary: "Print the current VM stdout and stderr logs.",
    usage: ["crucible vm logs"],
  },
  {
    canonical: "snapshot:create",
    preferred: "snapshot create",
    group: "snapshot",
    summary: "Create a QMP/qcow2 snapshot; defaults to clean-base when name is omitted.",
    usage: ["crucible snapshot create [name]"],
  },
  {
    canonical: "snapshot:list",
    preferred: "snapshot list",
    group: "snapshot",
    summary: "List snapshots recorded in the artifact manifest.",
    usage: ["crucible snapshot list"],
  },
  {
    canonical: "snapshot:restore",
    preferred: "snapshot restore",
    group: "snapshot",
    summary: "Restore a QMP/qcow2 snapshot; defaults to clean-base when name is omitted.",
    usage: ["crucible snapshot restore [name]"],
    examples: ["crucible snapshot restore clean-base"],
  },
  {
    canonical: "net:plan",
    preferred: "network plan",
    group: "network",
    aliases: ["net plan"],
    summary: "Print QEMU network args and firewall plans.",
    usage: [
      "crucible network plan [--mode isolated|nat|capture] [--backend nftables|iptables] [--apply]",
    ],
  },
  {
    canonical: "net:status",
    preferred: "network status",
    group: "network",
    aliases: ["net status"],
    summary: "Show configured network mode and egress posture.",
    usage: ["crucible network status"],
  },
  {
    canonical: "net:set",
    preferred: "network set",
    group: "network",
    aliases: ["net set"],
    summary: "Preview a switch to isolated, NAT, or capture mode.",
    usage: ["crucible network set isolated|nat|capture"],
  },
  {
    canonical: "net:teardown",
    preferred: "network teardown",
    group: "network",
    aliases: ["net teardown"],
    summary: "Print project-owned network teardown commands.",
    usage: [
      "crucible network teardown [--mode isolated|nat|capture] [--backend nftables|iptables] [--dry-run|--apply]",
    ],
  },
  {
    canonical: "guest:health",
    preferred: "guest health",
    group: "guest",
    summary: "Check guest-agent and Windows policy health.",
    usage: ["crucible guest health"],
  },
  {
    canonical: "guest:exec",
    preferred: "guest exec",
    group: "guest",
    summary: "Run a command through the Windows guest agent.",
    usage: ["crucible guest exec [--as service|standard|admin] <executable> [args...]"],
    examples: ["crucible guest exec --as admin whoami.exe"],
  },
  {
    canonical: "debug:smoke",
    preferred: "debug smoke",
    group: "debug",
    summary: "Run a CDB smoke command against a guest executable.",
    usage: ["crucible debug smoke --exe <guest-executable>"],
  },
  {
    canonical: "scenario:malware-dry-run",
    preferred: "scenario malware-dry-run",
    group: "scenario",
    summary: "Print the malware-analysis dry-run workflow.",
    usage: ["crucible scenario malware-dry-run"],
  },
];

export const CLI_COMMANDS: readonly CommandDefinition[] = COMMANDS;

function parseCliInvocation(args: readonly string[]): ParsedCliInvocation {
  const separatorIndex = args.indexOf("--");
  const commandArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  const helpIndex = commandArgs.findIndex((arg) => arg === "--help" || arg === "-h");
  if (args.length === 0 || helpIndex === 0) {
    return { kind: "help", text: getHelpText() };
  }

  if (args[0] === "help") {
    const tokens = args.slice(1);
    const help = getHelpForTokens(tokens);
    return help.kind === "unknown"
      ? { kind: "unknown-help", command: help.command }
      : { kind: "help", text: help.text };
  }

  if (helpIndex > 0) {
    const tokens = args.slice(0, helpIndex);
    const help = getHelpForTokens(tokens);
    return help.kind === "unknown"
      ? { kind: "unknown-help", command: help.command }
      : { kind: "help", text: help.text };
  }

  const direct = getCommandByName(args[0]);
  if (direct !== undefined) {
    return { kind: "command", command: direct.canonical, rest: args.slice(1) };
  }

  const groupName = normalizeCommandGroupName(args[0]);
  if (groupName !== undefined) {
    if (args[1] === undefined) {
      return { kind: "help", text: getGroupHelpText(groupName) };
    }

    const command = getCommandByGroupedName(groupName, args[1]);
    if (command !== undefined) {
      return { kind: "command", command: command.canonical, rest: args.slice(2) };
    }

    return { kind: "unknown", command: [args[0], args[1]].filter(Boolean).join(" ") };
  }

  return { kind: "unknown", command: args[0] ?? "" };
}

type HelpLookupResult =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "unknown"; readonly command: string };

function getHelpForTokens(tokens: readonly string[]): HelpLookupResult {
  if (tokens.length === 0) {
    return { kind: "help", text: getHelpText() };
  }

  const direct = tokens.length === 1 ? getCommandByName(tokens[0]) : undefined;
  if (direct !== undefined) {
    return { kind: "help", text: getCommandHelpText(direct) };
  }

  const groupName = normalizeCommandGroupName(tokens[0]);
  if (groupName === undefined) {
    return { kind: "unknown", command: tokens[0] ?? "" };
  }

  if (tokens.length === 1) {
    return { kind: "help", text: getGroupHelpText(groupName) };
  }

  const command = getCommandByGroupedName(groupName, tokens[1]);
  return command === undefined
    ? { kind: "unknown", command: [tokens[0], tokens[1]].filter(Boolean).join(" ") }
    : { kind: "help", text: getCommandHelpText(command) };
}

function getCommandByName(name: string | undefined): CommandDefinition | undefined {
  if (name === undefined) {
    return undefined;
  }

  return COMMANDS.find(
    (command) =>
      command.canonical === name || command.preferred === name || command.aliases?.includes(name),
  );
}

function getCommandByGroupedName(
  groupName: string,
  subcommand: string | undefined,
): CommandDefinition | undefined {
  if (subcommand === undefined) {
    return undefined;
  }

  return COMMANDS.find((command) => {
    if (command.group !== groupName) {
      return false;
    }
    const preferredSubcommand = command.preferred.split(" ").at(1);
    const aliasSubcommands = (command.aliases ?? [])
      .map((alias) => alias.split(" ").at(1))
      .filter((value): value is string => value !== undefined);
    return preferredSubcommand === subcommand || aliasSubcommands.includes(subcommand);
  });
}

function normalizeCommandGroupName(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }

  return COMMAND_GROUPS.find((group) => group.name === name || group.aliases?.includes(name))?.name;
}

function renderUnknownCommand(command: string): string {
  const suggestion = findClosestCommand(command);
  return [
    `Unknown command: ${command}`,
    suggestion === undefined ? undefined : `Did you mean: crucible ${suggestion}?`,
    "",
    getHelpText(),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function findClosestCommand(input: string): string | undefined {
  const normalizedInput = normalizeSuggestionText(input);
  let best: { readonly command: string; readonly distance: number } | undefined;
  for (const command of COMMANDS) {
    for (const candidate of [command.preferred, command.canonical, ...(command.aliases ?? [])]) {
      const distance = levenshteinDistance(normalizedInput, normalizeSuggestionText(candidate));
      if (best === undefined || distance < best.distance) {
        best = { command: command.preferred, distance };
      }
    }
  }

  if (best === undefined || best.distance > Math.max(2, Math.floor(normalizedInput.length / 3))) {
    return undefined;
  }
  return best.command;
}

function normalizeSuggestionText(value: string): string {
  return value.replaceAll(":", " ").replaceAll(/\s+/g, " ").toLowerCase();
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function getHelpText(): string {
  return [
    "crucible",
    "",
    "Usage:",
    "  crucible <command> [options]",
    "  crucible <group> <command> [options]",
    "  crucible <group> --help",
    "",
    "Common workflows:",
    "  crucible config init",
    "  crucible doctor",
    "  crucible setup host --print",
    "  crucible provision",
    "  crucible vm status",
    "  crucible snapshot restore clean-base",
    "  crucible mcp --stdio",
    "",
    "Command groups:",
    ...COMMAND_GROUPS.map(
      (group) => `  ${group.name.padEnd(10)} ${group.summary}${formatGroupAliases(group)}`,
    ),
    "",
    "Commands:",
    ...COMMANDS.filter((command) => command.group === undefined).map(formatCommandSummary),
    ...COMMAND_GROUPS.flatMap((group) =>
      COMMANDS.filter((command) => command.group === group.name).map(formatCommandSummary),
    ),
    "",
    "Legacy colon commands still work, for example `crucible vm:status`.",
    "Run `crucible <group> --help` or `crucible <group> <command> --help` for details.",
  ].join("\n");
}

function getGroupHelpText(groupName: string): string {
  const group = COMMAND_GROUPS.find((candidate) => candidate.name === groupName);
  if (group === undefined) {
    return getHelpText();
  }
  const commands = COMMANDS.filter((command) => command.group === group.name);
  return [
    `crucible ${group.name}`,
    "",
    group.summary,
    group.aliases === undefined ? undefined : `Aliases: ${group.aliases.join(", ")}`,
    "",
    "Usage:",
    `  crucible ${group.name} <command> [options]`,
    "",
    "Commands:",
    ...commands.map(formatCommandSummary),
    "",
    "Examples:",
    ...commands
      .flatMap((command) => command.examples ?? command.usage.slice(0, 1))
      .map((example) => `  ${example}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function getCommandHelpText(command: CommandDefinition): string {
  return [
    `crucible ${command.preferred}`,
    "",
    command.summary,
    "",
    "Usage:",
    ...command.usage.map((usage) => `  ${usage}`),
    command.aliases === undefined && !command.canonical.includes(":")
      ? undefined
      : `Aliases: ${[command.canonical, ...(command.aliases ?? [])].join(", ")}`,
    command.examples === undefined ? undefined : "",
    command.examples === undefined ? undefined : "Examples:",
    ...(command.examples ?? []).map((example) => `  ${example}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatCommandSummary(command: CommandDefinition): string {
  return `  ${command.preferred.padEnd(28)} ${command.summary}`;
}

function formatGroupAliases(group: CommandGroupDefinition): string {
  return group.aliases === undefined ? "" : ` (alias: ${group.aliases.join(", ")})`;
}

if (isCliEntrypoint()) {
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

function isCliEntrypoint(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}
