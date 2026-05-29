import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  buildAnalysisVmPolicyScriptArguments,
  defaultAnalysisVmPolicyConfig,
  type AnalysisVmPolicyConfig,
} from "./analysis-policy.js";
import { defaultCrucibleConfig, type CrucibleConfig } from "./config.js";
import { CrucibleError } from "./errors.js";
import { type VmLifecycleManager, type VmStatus } from "./lifecycle.js";
import { ensureMtlsBundle } from "./mtls.js";
import { buildNetworkPlan } from "./network.js";
import type { ProcessCommand, ProcessRunner } from "./process.js";
import { buildQemuCommandPlan } from "./qemu.js";
import { QmpClient } from "./qmp.js";
import { type SnapshotCreateResult } from "./snapshot.js";

export const PROVISIONING_STAGE_IDS = [
  "media-ready",
  "vm-booted",
  "qga-ready",
  "windbg-installed",
  "analysis-tools-installed",
  "local-accounts-created",
  "guest-agent-installed",
  "policy-configured",
  "health-checked",
  "snapshot-prepared",
] as const;

export const PROVISIONING_SCRIPT_RUNNERS = [
  "host",
  "qga-powershell",
  "guest-agent-powershell",
] as const;

export const PROVISIONING_SECRET_KINDS = [
  "windows-standard-password",
  "windows-admin-password",
  "mtls-ca-private-key",
  "mtls-ca-certificate",
  "mtls-host-client-private-key",
  "mtls-host-client-certificate",
  "mtls-guest-server-private-key",
  "mtls-guest-server-certificate",
] as const;

export type ProvisioningStageId = (typeof PROVISIONING_STAGE_IDS)[number];
export type ProvisioningScriptRunner = (typeof PROVISIONING_SCRIPT_RUNNERS)[number];
export type ProvisioningSecretKind = (typeof PROVISIONING_SECRET_KINDS)[number];

export type ProvisioningStageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type ProvisioningRunStatus = "notStarted" | "running" | "blocked" | "complete";

export type ProvisioningReadinessCheck = {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
};

export type ProvisioningScriptInvocationContract = {
  readonly id: string;
  readonly runner: ProvisioningScriptRunner;
  readonly executable: string;
  readonly scriptPath: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly elevated: boolean;
  readonly redactedArgumentIndexes: readonly number[];
  readonly environmentSecretRefs: readonly ProvisioningSecretKind[];
};

export type ProvisioningScriptResult = {
  readonly invocationId: string;
  readonly stageId: ProvisioningStageId;
  readonly status: "succeeded" | "failed" | "timedOut" | "skipped";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
};

export type ProvisioningSecretRef = {
  readonly kind: ProvisioningSecretKind;
  readonly id: string;
  readonly path: string;
  readonly fileMode: "0600";
  readonly format: "json" | "pem";
  readonly principal?: "standard" | "admin" | "host" | "guest" | "ca";
};

export type ProvisioningSecretStorageContract = {
  readonly rootDirectory: string;
  readonly secretRefs: readonly ProvisioningSecretRef[];
  readonly manifestArtifactKind: "credential";
  readonly redactedResultFields: readonly string[];
};

export type ProvisioningStageContract = {
  readonly id: ProvisioningStageId;
  readonly title: string;
  readonly dependsOn: readonly ProvisioningStageId[];
  readonly readinessChecks: readonly ProvisioningReadinessCheck[];
  readonly script?: ProvisioningScriptInvocationContract;
  readonly producesSecrets: readonly ProvisioningSecretKind[];
  readonly producesSnapshot: boolean;
};

export type ProvisioningStageTransition = {
  readonly from: ProvisioningStageId | "start";
  readonly onSuccess: ProvisioningStageId | "complete";
  readonly onFailure: "blocked";
};

export type ProvisioningStageState = {
  readonly id: ProvisioningStageId;
  readonly status: ProvisioningStageStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: ProvisioningScriptResult;
};

export type ProvisioningStateMachine = {
  readonly version: 1;
  readonly status: ProvisioningRunStatus;
  readonly currentStageId?: ProvisioningStageId;
  readonly stages: readonly ProvisioningStageState[];
  readonly transitions: readonly ProvisioningStageTransition[];
};

export type ProvisioningPlan = {
  readonly version: 1;
  readonly vmName: string;
  readonly stages: readonly ProvisioningStageContract[];
  readonly stateMachine: ProvisioningStateMachine;
  readonly secrets: ProvisioningSecretStorageContract;
};

export type GuestHealthStatus = "healthy" | "degraded" | "unavailable";

export type GuestHealthCheckResult = {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
  readonly status: "pass" | "fail" | "unknown";
  readonly detail?: string;
};

export type GuestHealthReport = {
  readonly vmName: string;
  readonly status: GuestHealthStatus;
  readonly generatedAt: string;
  readonly lifecycleStatus: VmStatus["status"];
  readonly qmpAvailable: boolean;
  readonly vmProcessAlive: boolean;
  readonly controlEndpoint: string;
  readonly checks: readonly GuestHealthCheckResult[];
};

export type ProvisioningCommandStep = {
  readonly id: ProvisioningStageId | "snapshot-created";
  readonly title: string;
  readonly status: "succeeded" | "blocked";
  readonly detail: string;
};

export type ProvisioningCommandResult = {
  readonly vmName: string;
  readonly status: "complete" | "blocked";
  readonly snapshotName: string;
  readonly steps: readonly ProvisioningCommandStep[];
  readonly health: GuestHealthReport;
  readonly snapshot?: SnapshotCreateResult;
};

export type ProvisioningExecutor = {
  readonly runStage: (stage: ProvisioningStageContract) => Promise<ProvisioningCommandStep>;
};

export type ProvisioningCommandRunnerOptions = {
  readonly config?: CrucibleConfig;
  readonly lifecycleManager: Pick<VmLifecycleManager, "start" | "status">;
  readonly executor?: ProvisioningExecutor;
  readonly snapshotManager: {
    readonly create: (snapshotName: string) => Promise<SnapshotCreateResult>;
  };
  readonly now?: () => Date;
  readonly snapshotName?: string;
  readonly skipBootKeyNudge?: boolean;
};

export type RealFirstBootProvisioningOptions = {
  readonly config?: CrucibleConfig;
  readonly processRunner: ProcessRunner;
  readonly ovmfCodePath?: string;
  readonly ovmfVarsTemplatePath?: string;
  readonly qemuImgExecutable?: string;
  readonly xorrisoExecutable?: string;
  readonly opensslExecutable?: string;
  readonly timeoutMs?: number;
  /**
   * Host path to the cross-compiled Windows guest agent binary. Baked
   * into crucible-payload.iso so the guest can copy it into place
   * without going through qemu-ga writeFile (which races Windows
   * filesystem minifilters; see #130).
   */
  readonly agentBinaryPath?: string;
  /**
   * Host directory containing the per-stage PowerShell scripts that
   * provisioning invokes via guest-exec. Baked into the payload ISO
   * under /stages/. Defaults to `guest/provision/` relative to the
   * MCP host's working directory.
   */
  readonly provisioningScriptsDirectory?: string;
};

export type RealFirstBootProvisioningPlan = {
  readonly diskPath: string;
  readonly ovmfCodePath: string;
  readonly ovmfVarsPath: string;
  readonly swtpmSocketPath: string;
  readonly swtpmPidPath: string;
  readonly swtpmStateDirectory: string;
  readonly autounattendIsoPath: string;
  readonly payloadIsoPath: string;
  readonly mtlsBundleDirectory: string;
  readonly mtlsCaCertificatePath: string;
  readonly mtlsServerCertificatePath: string;
  readonly mtlsServerPrivateKeyPath: string;
  readonly mtlsHostClientCertificatePath: string;
  readonly mtlsHostClientPrivateKeyPath: string;
  readonly commands: readonly ProcessCommand[];
};

export type WindowsExecutionPrincipal = "standard" | "admin";

export type WindowsAccountSecret = {
  readonly username: string;
  readonly password: string;
  readonly principal: WindowsExecutionPrincipal;
  readonly generatedAt: string;
};

export type WindowsAccountSecretSummary = {
  readonly username: string;
  readonly principal: WindowsExecutionPrincipal;
  readonly path: string;
  readonly fileMode: "0600";
};

export type WindowsAccountSecretOptions = {
  readonly vmName: string;
  readonly secretsDirectory: string;
  readonly standardUsername?: string;
  readonly adminUsername?: string;
  readonly passwordLength?: number;
  readonly generatedAt?: Date;
  readonly randomBytes?: (size: number) => Buffer;
};

export type WindowsAccountSecretWriteResult = {
  readonly rootDirectory: string;
  readonly accounts: readonly WindowsAccountSecretSummary[];
};

export type GuestAgentCertificateStagePlan = {
  readonly caCertificateSecretPath: string;
  readonly guestServerCertificateSecretPath: string;
  readonly guestServerPrivateKeySecretPath: string;
  readonly guestStagingDirectory: string;
  readonly stagedCaCertificatePath: string;
  readonly stagedServerCertificatePath: string;
  readonly stagedServerPrivateKeyPath: string;
};

export type ProvisioningPlanOptions = {
  readonly vmName: string;
  readonly secretsDirectory: string;
  readonly controlPort: number;
  readonly guestAddress: string;
  readonly snapshotName?: string;
  readonly analysisPolicy?: AnalysisVmPolicyConfig;
};

// Use the full Windows path rather than a bare `powershell.exe`. qemu-ga's
// guest-exec resolves the executable via the qemu-ga service's PATH, which
// during the first few seconds after qga-ping returns can be incomplete
// (System32 not yet in PATH) and CreateProcessW fails with "No such file
// or directory" before our retry layer even sees the call as transient.
// The path is stable across every supported Windows SKU.
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_SCRIPT_TIMEOUT_MS = 45 * 60 * 1000;
const PASSWORD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PASSWORD_LOWER = "abcdefghijkmnopqrstuvwxyz";
const PASSWORD_DIGIT = "23456789";
const PASSWORD_SYMBOL = "!#$%+,-.:=?@^_";
const PASSWORD_ALPHABET = `${PASSWORD_UPPER}${PASSWORD_LOWER}${PASSWORD_DIGIT}${PASSWORD_SYMBOL}`;

export const PROVISIONING_STAGE_TRANSITIONS: readonly ProvisioningStageTransition[] = [
  { from: "start", onSuccess: "media-ready", onFailure: "blocked" },
  { from: "media-ready", onSuccess: "vm-booted", onFailure: "blocked" },
  { from: "vm-booted", onSuccess: "qga-ready", onFailure: "blocked" },
  { from: "qga-ready", onSuccess: "windbg-installed", onFailure: "blocked" },
  { from: "windbg-installed", onSuccess: "analysis-tools-installed", onFailure: "blocked" },
  { from: "analysis-tools-installed", onSuccess: "local-accounts-created", onFailure: "blocked" },
  { from: "local-accounts-created", onSuccess: "guest-agent-installed", onFailure: "blocked" },
  { from: "guest-agent-installed", onSuccess: "policy-configured", onFailure: "blocked" },
  { from: "policy-configured", onSuccess: "health-checked", onFailure: "blocked" },
  { from: "health-checked", onSuccess: "snapshot-prepared", onFailure: "blocked" },
  { from: "snapshot-prepared", onSuccess: "complete", onFailure: "blocked" },
];

export function buildProvisioningPlan(options: ProvisioningPlanOptions): ProvisioningPlan {
  return {
    version: 1,
    vmName: options.vmName,
    stages: buildProvisioningStageContracts(options),
    stateMachine: createInitialProvisioningStateMachine(),
    secrets: buildProvisioningSecretStorageContract(options.vmName, options.secretsDirectory),
  };
}

export async function runProvisioningCommand(
  options: ProvisioningCommandRunnerOptions,
): Promise<ProvisioningCommandResult> {
  const config = options.config ?? defaultCrucibleConfig;
  const snapshotName = options.snapshotName ?? "clean-base";
  const plan = buildProvisioningPlan({
    vmName: config.vm.name,
    secretsDirectory: config.artifacts.secretsDirectory,
    controlPort: config.network.controlPort,
    guestAddress: getGuestControlAddress(config),
    snapshotName,
    analysisPolicy: config.analysisPolicy,
  });
  const executor = options.executor ?? blockedProvisioningExecutor;
  const steps: ProvisioningCommandStep[] = [];

  await options.lifecycleManager.start();
  if (options.skipBootKeyNudge !== true) {
    await sendFirstBootIsoKey(config);
  }

  for (const stage of plan.stages) {
    const step = await executor.runStage(stage);
    steps.push(step);
    if (step.status === "blocked") {
      return {
        vmName: config.vm.name,
        status: "blocked",
        snapshotName,
        steps,
        health: buildGuestHealthReport({
          config,
          lifecycleStatus: await options.lifecycleManager.status(),
          plan,
          now: options.now,
        }),
      };
    }
  }

  const snapshot = await options.snapshotManager.create(snapshotName);
  steps.push({
    id: "snapshot-created",
    title: "Clean snapshot created",
    status: "succeeded",
    detail: snapshot.snapshot.path,
  });

  return {
    vmName: config.vm.name,
    status: "complete",
    snapshotName,
    steps,
    snapshot,
    health: buildGuestHealthReport({
      config,
      lifecycleStatus: await options.lifecycleManager.status(),
      plan,
      now: options.now,
    }),
  };
}

async function sendFirstBootIsoKey(config: CrucibleConfig): Promise<void> {
  const deadline = Date.now() + 90_000;
  let bootIssued = false;

  while (Date.now() < deadline) {
    const qmp = new QmpClient({
      socketPath: config.qmp.socketPath,
      timeoutMs: config.qmp.timeoutMs,
    });
    try {
      await qmp.connect();
      if (!bootIssued) {
        // Wait briefly for the UEFI Shell prompt to settle before typing.
        await sleep(8000);
        // Select the Windows installer's EFI System Partition. With ich9-ahci
        // port 0 hosting the Windows ISO, OVMF enumerates it as FS0.
        await sendUefiShellCommand(qmp, "fs0:");
        await sleep(500);
        await sendUefiShellCommand(qmp, "efi\\boot\\bootx64.efi");
        bootIssued = true;
      }
      // bootmgr prints "Press any key to boot from CD or DVD" with a short
      // timeout; spam Enter until the installer takes over.
      for (let index = 0; index < 30; index += 1) {
        await qmp.execute("human-monitor-command", {
          "command-line": "sendkey ret 20",
        });
        await sleep(300);
      }
      return;
    } catch {
      await sleep(500);
    } finally {
      qmp.close();
    }
  }
}

async function sendUefiShellCommand(qmp: QmpClient, command: string): Promise<void> {
  for (const key of commandToQemuKeys(command)) {
    await qmp.execute("human-monitor-command", {
      "command-line": `sendkey ${key} 20`,
    });
    await sleep(60);
  }
  await qmp.execute("human-monitor-command", {
    "command-line": "sendkey ret 20",
  });
}

export function commandToQemuKeys(command: string): readonly string[] {
  const keyMap: Record<string, string> = {
    "\\": "backslash",
    ":": "shift-semicolon",
    ".": "dot",
    "-": "minus",
  };

  return [...command].map((character) => keyMap[character] ?? character.toLowerCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function prepareRealFirstBootProvisioning(
  options: RealFirstBootProvisioningOptions,
): Promise<RealFirstBootProvisioningPlan> {
  const config = options.config ?? defaultCrucibleConfig;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const qemuImgExecutable = options.qemuImgExecutable ?? "qemu-img";
  const xorrisoExecutable = options.xorrisoExecutable ?? "xorriso";
  const ovmfCodePath = options.ovmfCodePath ?? "/usr/share/OVMF/OVMF_CODE_4M.fd";
  const ovmfVarsTemplatePath = options.ovmfVarsTemplatePath ?? "/usr/share/OVMF/OVMF_VARS_4M.fd";
  const plan = buildQemuCommandPlan({ config });
  const bootDirectory = path.join(config.artifacts.directory, "boot");
  const ovmfVarsPath = path.join(bootDirectory, `${config.vm.name}.OVMF_VARS.fd`);
  const swtpmStateDirectory = path.join(config.artifacts.directory, "swtpm", config.vm.name);
  const swtpmSocketPath = path.join(swtpmStateDirectory, "swtpm.sock");
  const swtpmPidPath = path.join(swtpmStateDirectory, "swtpm.pid");
  const autounattendIsoPath = path.join(bootDirectory, "autounattend.iso");
  const windowsIsoPath = config.media.windowsIso?.path;
  const virtioIsoPath = config.media.virtioIso?.path;

  if (windowsIsoPath === undefined || virtioIsoPath === undefined) {
    throw new CrucibleError(
      "MEDIA_UNAVAILABLE",
      "Real provisioning requires local Windows and virtio ISO paths",
      {
        windowsIsoPath,
        virtioIsoPath,
      },
    );
  }

  await assertReadableFile("Windows ISO", windowsIsoPath);
  await assertReadableFile("virtio ISO", virtioIsoPath);
  await assertReadableFile("OVMF code", ovmfCodePath);
  await assertReadableFile("OVMF vars template", ovmfVarsTemplatePath);
  await mkdir(path.dirname(plan.disk.path), { recursive: true });
  await mkdir(bootDirectory, { recursive: true, mode: 0o700 });
  await chmod(bootDirectory, 0o700);
  await mkdir(swtpmStateDirectory, { recursive: true });
  if (!(await pathExists(ovmfVarsPath))) {
    await copyFile(ovmfVarsTemplatePath, ovmfVarsPath);
  }
  const accounts = await ensureWindowsAccountSecrets({
    vmName: config.vm.name,
    secretsDirectory: config.artifacts.secretsDirectory,
  });
  const autounattendXmlPath = path.join(bootDirectory, "Autounattend.xml");
  await writeFile(autounattendXmlPath, buildAutounattendXml(config, accounts), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(autounattendXmlPath, 0o600);
  await writeFile(path.join(bootDirectory, "startup.nsh"), buildStartupNsh(), "utf8");
  await writeFile(
    path.join(bootDirectory, "crucible-install.cmd"),
    buildWinPeInstallScript(config),
    "utf8",
  );
  await mkdir(path.join(bootDirectory, "$OEM$", "$$", "Setup", "Scripts"), { recursive: true });
  await writeFile(
    path.join(bootDirectory, "$OEM$", "$$", "Setup", "Scripts", "SetupComplete.cmd"),
    buildSetupCompleteScript(),
    "utf8",
  );
  await copyVirtioDriverDirectories({
    virtioIsoPath,
    bootDirectory,
    profile: config.media.profile,
    processRunner: options.processRunner,
    timeoutMs,
  });

  // Remove any leftover autounattend.iso from a previous run before xorriso
  // re-creates it. xorriso adds every file under the source directory to the
  // ISO; including the previous-run's output ISO inside that directory makes
  // it modify-while-reading, which exits with MISHAP (status 32) and the
  // logspam "Size of file ... has changed. It will be padded with 0's".
  try {
    await rm(autounattendIsoPath, { force: true });
  } catch {
    // best-effort; xorriso will error loudly with stderr context if the
    // unlink truly mattered.
  }

  const commands: ProcessCommand[] = [
    ...((await pathExists(plan.disk.path))
      ? []
      : [
          {
            executable: qemuImgExecutable,
            args: ["create", "-f", "qcow2", plan.disk.path, `${config.vm.diskGiB}G`],
            timeoutMs,
            maxOutputBytes: 1024 * 1024,
          },
        ]),
    {
      executable: xorrisoExecutable,
      args: [
        "-as",
        "mkisofs",
        "-J",
        "-joliet-long",
        "-r",
        "-o",
        autounattendIsoPath,
        "-V",
        "AUTOUNATTEND",
        bootDirectory,
      ],
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    },
  ];

  for (const command of commands) {
    await runProvisioningProcess(options.processRunner, command);
  }

  // The autounattend ISO embeds plaintext local-account passwords. Pair the
  // permissions on the rendered XML and bundled ISO so they stay
  // user-readable only, matching artifacts/secrets/<vm>/. Tests stub the
  // process runner and never produce the ISO, so a missing file is tolerated.
  try {
    await chmod(autounattendIsoPath, 0o600);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  // Per-VM mTLS bundle for the guest agent. Generated once and reused on
  // subsequent provisions so the operator can pin the same CA in their
  // MCP client config.
  const mtls = await ensureMtlsBundle({
    vmName: config.vm.name,
    secretsDirectory: config.artifacts.secretsDirectory,
    guestAddress: getGuestControlAddress(config),
    opensslExecutable: options.opensslExecutable,
  });

  // crucible-payload.iso — read-only CD-ROM with the agent binary, mTLS
  // material, and per-stage PowerShell scripts. Mounted as the 4th
  // CD-ROM at VM start; guest scripts (install-agent.ps1) copy from
  // it via WMI + Win32_LogicalDisk(DriveType=5,VolumeName=CRUCIBLE).
  // This is the cidata/NoCloud pattern used by cloud-init, Packer,
  // and KubeVirt — it sidesteps qemu-ga's ERROR_SHARING_VIOLATION
  // race against Windows filesystem minifilters (#130) entirely.
  const payloadIsoPath = path.join(bootDirectory, "crucible-payload.iso");
  const provisioningScriptsDirectory =
    options.provisioningScriptsDirectory ?? path.resolve("guest", "provision");
  const payloadIsoCommand = await buildPayloadIsoCommand({
    xorrisoExecutable,
    outputPath: payloadIsoPath,
    bootDirectory,
    agentBinaryPath: options.agentBinaryPath,
    mtlsCaCertificatePath: mtls.caCertificatePath,
    mtlsServerCertificatePath: mtls.serverCertificatePath,
    mtlsServerPrivateKeyPath: mtls.serverPrivateKeyPath,
    provisioningScriptsDirectory,
    timeoutMs,
  });
  await runProvisioningProcess(options.processRunner, payloadIsoCommand);
  // 0600: the payload ISO contains the mTLS server private key.
  try {
    await chmod(payloadIsoPath, 0o600);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    diskPath: plan.disk.path,
    ovmfCodePath,
    ovmfVarsPath,
    swtpmSocketPath,
    swtpmPidPath,
    swtpmStateDirectory,
    autounattendIsoPath,
    payloadIsoPath,
    mtlsBundleDirectory: mtls.directory,
    mtlsCaCertificatePath: mtls.caCertificatePath,
    mtlsServerCertificatePath: mtls.serverCertificatePath,
    mtlsServerPrivateKeyPath: mtls.serverPrivateKeyPath,
    mtlsHostClientCertificatePath: mtls.hostClientCertificatePath,
    mtlsHostClientPrivateKeyPath: mtls.hostClientPrivateKeyPath,
    commands: [...commands, payloadIsoCommand],
  };
}

async function buildPayloadIsoCommand(options: {
  readonly xorrisoExecutable: string;
  readonly outputPath: string;
  readonly bootDirectory: string;
  readonly agentBinaryPath: string | undefined;
  readonly mtlsCaCertificatePath: string;
  readonly mtlsServerCertificatePath: string;
  readonly mtlsServerPrivateKeyPath: string;
  readonly provisioningScriptsDirectory: string;
  readonly timeoutMs: number;
}): Promise<ProcessCommand> {
  // Remove any leftover payload.iso from a previous run before xorriso
  // re-creates it — same reason as autounattend.iso (xorriso would add
  // its own previous output to the new ISO and exit MISHAP).
  try {
    await rm(options.outputPath, { force: true });
  } catch {
    // best effort
  }
  await assertReadableFile("mTLS CA certificate", options.mtlsCaCertificatePath);
  await assertReadableFile("mTLS server certificate", options.mtlsServerCertificatePath);
  await assertReadableFile("mTLS server private key", options.mtlsServerPrivateKeyPath);
  await assertReadableDirectory(
    "provisioning scripts directory",
    options.provisioningScriptsDirectory,
  );
  const graftPoints: string[] = [
    `/mtls/ca.cert.pem=${options.mtlsCaCertificatePath}`,
    `/mtls/guest-server.cert.pem=${options.mtlsServerCertificatePath}`,
    `/mtls/guest-server.key.pem=${options.mtlsServerPrivateKeyPath}`,
    `/stages/=${options.provisioningScriptsDirectory.endsWith("/") ? options.provisioningScriptsDirectory : `${options.provisioningScriptsDirectory}/`}`,
  ];
  if (options.agentBinaryPath !== undefined) {
    await assertReadableFile("guest agent binary", options.agentBinaryPath);
    graftPoints.push(`/agent/crucible-agent.exe=${options.agentBinaryPath}`);
  }
  return {
    executable: options.xorrisoExecutable,
    args: [
      "-as",
      "mkisofs",
      "-V",
      "CRUCIBLE",
      "-J",
      "-joliet-long",
      "-r",
      "-iso-level",
      "3",
      "-graft-points",
      "-o",
      options.outputPath,
      ...graftPoints,
    ],
    timeoutMs: options.timeoutMs,
    maxOutputBytes: 1024 * 1024,
  };
}

function buildStartupNsh(): string {
  return [
    "@echo -off",
    "for %a in (fs0 fs1 fs2 fs3 fs4 fs5 fs6 fs7 fs8 fs9)",
    "  if exist %a:\\efi\\boot\\bootx64.efi then",
    "    %a:\\efi\\boot\\bootx64.efi",
    "  endif",
    "endfor",
  ].join("\r\n");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

type EmbeddedAccount = {
  readonly username: string;
  readonly password: string;
  readonly principal: WindowsExecutionPrincipal;
};

async function ensureWindowsAccountSecrets(options: {
  readonly vmName: string;
  readonly secretsDirectory: string;
}): Promise<readonly EmbeddedAccount[]> {
  const contract = buildProvisioningSecretStorageContract(options.vmName, options.secretsDirectory);
  const standardRef = requiredSecretRef(contract, "windows-standard-password");
  const adminRef = requiredSecretRef(contract, "windows-admin-password");
  if (!(await pathExists(standardRef.path)) || !(await pathExists(adminRef.path))) {
    await writeWindowsAccountSecrets({
      vmName: options.vmName,
      secretsDirectory: options.secretsDirectory,
    });
  }
  const [standardRaw, adminRaw] = await Promise.all([
    readFile(standardRef.path, "utf8"),
    readFile(adminRef.path, "utf8"),
  ]);
  const standard = JSON.parse(standardRaw) as WindowsAccountSecret;
  const admin = JSON.parse(adminRaw) as WindowsAccountSecret;
  return [
    { username: admin.username, password: admin.password, principal: "admin" },
    { username: standard.username, password: standard.password, principal: "standard" },
  ];
}

function buildAutounattendXml(
  config: CrucibleConfig,
  accounts: readonly EmbeddedAccount[],
): string {
  const adminAccount = accounts.find((a) => a.principal === "admin");
  if (adminAccount === undefined) {
    throw new CrucibleError(
      "STATE_INVALID",
      "Autounattend generation requires an admin account secret",
      {},
    );
  }
  const computerName = config.vm.name.slice(0, 15);
  const localAccountLines: string[] = [];
  for (const account of accounts) {
    const group = account.principal === "admin" ? "Administrators" : "Users";
    localAccountLines.push(
      '          <LocalAccount wcm:action="add">',
      `            <Name>${escapeXml(account.username)}</Name>`,
      `            <Group>${group}</Group>`,
      `            <DisplayName>${escapeXml(account.username)}</DisplayName>`,
      "            <Password>",
      `              <Value>${escapeXml(account.password)}</Value>`,
      "              <PlainText>true</PlainText>",
      "            </Password>",
      "          </LocalAccount>",
    );
  }
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">',
    '  <settings pass="windowsPE">',
    '    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    "      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>",
    "      <InputLocale>en-US</InputLocale>",
    "      <SystemLocale>en-US</SystemLocale>",
    "      <UILanguage>en-US</UILanguage>",
    "      <UserLocale>en-US</UserLocale>",
    "    </component>",
    '    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    "      <RunSynchronous>",
    '        <RunSynchronousCommand wcm:action="add">',
    "          <Order>1</Order>",
    "          <Path>cmd /c reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassTPMCheck /t REG_DWORD /d 1 /f</Path>",
    "        </RunSynchronousCommand>",
    '        <RunSynchronousCommand wcm:action="add">',
    "          <Order>2</Order>",
    "          <Path>cmd /c reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassSecureBootCheck /t REG_DWORD /d 1 /f</Path>",
    "        </RunSynchronousCommand>",
    '        <RunSynchronousCommand wcm:action="add">',
    "          <Order>3</Order>",
    "          <Path>cmd /c reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassRAMCheck /t REG_DWORD /d 1 /f</Path>",
    "        </RunSynchronousCommand>",
    '        <RunSynchronousCommand wcm:action="add">',
    "          <Order>4</Order>",
    "          <Path>cmd /c for %d in (C D E F G H I J K L M N O P Q R S T U V W X Y Z) do @if exist %d:\\crucible-install.cmd %d:\\crucible-install.cmd</Path>",
    "        </RunSynchronousCommand>",
    "      </RunSynchronous>",
    "      <UserData><AcceptEula>true</AcceptEula></UserData>",
    "    </component>",
    "  </settings>",
    '  <settings pass="specialize">',
    '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    `      <ComputerName>${escapeXml(computerName)}</ComputerName>`,
    "      <TimeZone>UTC</TimeZone>",
    "    </component>",
    '    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    "      <RunSynchronous>",
    '        <RunSynchronousCommand wcm:action="add">',
    "          <Order>1</Order>",
    '          <Path>reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE" /v BypassNRO /t REG_DWORD /d 1 /f</Path>',
    "        </RunSynchronousCommand>",
    // Disable Windows Defender real-time / on-access scanning via policy
    // registry keys BEFORE the Defender service starts up in oobeSystem.
    // Tamper Protection blocks Set-MpPreference at runtime but does NOT
    // block these Policy keys when written in `specialize` ahead of the
    // Defender service registering its minifilter. Without this, the
    // first qemu-ga guest-file-open for any .ps1 we stage under
    // C:\ProgramData\Crucible\stages\ races Defender's on-create scan
    // and fails with ERROR_SHARING_VIOLATION (`The process cannot
    // access the file because it is being used by another process.`).
    // configure-policy.ps1 still runs at the regular stage to lock down
    // the rest of the analysis-VM policy surface.
    '        <RunSynchronousCommand wcm:action="add">',
    "          <Order>2</Order>",
    '          <Path>reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender" /v DisableAntiSpyware /t REG_DWORD /d 1 /f</Path>',
    "        </RunSynchronousCommand>",
    '        <RunSynchronousCommand wcm:action="add">',
    "          <Order>3</Order>",
    '          <Path>reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection" /v DisableRealtimeMonitoring /t REG_DWORD /d 1 /f</Path>',
    "        </RunSynchronousCommand>",
    '        <RunSynchronousCommand wcm:action="add">',
    "          <Order>4</Order>",
    '          <Path>reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection" /v DisableOnAccessProtection /t REG_DWORD /d 1 /f</Path>',
    "        </RunSynchronousCommand>",
    "      </RunSynchronous>",
    "    </component>",
    "  </settings>",
    '  <settings pass="oobeSystem">',
    '    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    "      <InputLocale>en-US</InputLocale>",
    "      <SystemLocale>en-US</SystemLocale>",
    "      <UILanguage>en-US</UILanguage>",
    "      <UserLocale>en-US</UserLocale>",
    "    </component>",
    '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    "      <OOBE>",
    "        <HideEULAPage>true</HideEULAPage>",
    "        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>",
    "        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>",
    "        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>",
    "        <NetworkLocation>Work</NetworkLocation>",
    "        <ProtectYourPC>3</ProtectYourPC>",
    "        <SkipMachineOOBE>true</SkipMachineOOBE>",
    "        <SkipUserOOBE>true</SkipUserOOBE>",
    "      </OOBE>",
    "      <UserAccounts>",
    "        <LocalAccounts>",
    ...localAccountLines,
    "        </LocalAccounts>",
    "      </UserAccounts>",
    "      <AutoLogon>",
    `        <Username>${escapeXml(adminAccount.username)}</Username>`,
    "        <Enabled>true</Enabled>",
    "        <LogonCount>3</LogonCount>",
    "        <Password>",
    `          <Value>${escapeXml(adminAccount.password)}</Value>`,
    "          <PlainText>true</PlainText>",
    "        </Password>",
    "      </AutoLogon>",
    "      <TimeZone>UTC</TimeZone>",
    "    </component>",
    "  </settings>",
    "</unattend>",
  ].join("\n");
}

function buildWinPeInstallScript(config: CrucibleConfig): string {
  const osFolder = config.media.profile === "windows-server-2025-eval" ? "2k25" : "w11";
  return [
    "@echo off",
    "setlocal EnableExtensions EnableDelayedExpansion",
    "for %%d in (C D E F G H I J K L M N O P Q R S T U V W X Y Z) do (",
    "  if exist %%d:\\sources\\install.wim set IMAGE_FILE=%%d:\\sources\\install.wim",
    "  if exist %%d:\\sources\\install.esd set IMAGE_FILE=%%d:\\sources\\install.esd",
    "  if exist %%d:\\drivers\\vioscsi\\vioscsi.inf set DRIVER_ROOT=%%d:\\drivers",
    "  if exist %%d:\\Autounattend.xml set ANSWER_FILE=%%d:\\Autounattend.xml",
    ")",
    "if not defined IMAGE_FILE echo Missing Windows install image & pause & exit /b 1",
    "if not defined DRIVER_ROOT echo Missing Crucible driver media & pause & exit /b 1",
    "if not defined ANSWER_FILE echo Missing Crucible answer file & pause & exit /b 1",
    `if exist %DRIVER_ROOT%\\vioscsi\\vioscsi.inf drvload %DRIVER_ROOT%\\vioscsi\\vioscsi.inf`,
    `if exist %DRIVER_ROOT%\\NetKVM\\netkvm.inf drvload %DRIVER_ROOT%\\NetKVM\\netkvm.inf`,
    `if exist %DRIVER_ROOT%\\vioserial\\vioser.inf drvload %DRIVER_ROOT%\\vioserial\\vioser.inf`,
    ">X:\\diskpart-crucible.txt echo SELECT DISK=0",
    ">>X:\\diskpart-crucible.txt echo CLEAN",
    ">>X:\\diskpart-crucible.txt echo CONVERT GPT",
    ">>X:\\diskpart-crucible.txt echo CREATE PARTITION EFI SIZE=100",
    ">>X:\\diskpart-crucible.txt echo FORMAT QUICK FS=FAT32 LABEL=System",
    ">>X:\\diskpart-crucible.txt echo ASSIGN LETTER=S",
    ">>X:\\diskpart-crucible.txt echo CREATE PARTITION MSR SIZE=16",
    ">>X:\\diskpart-crucible.txt echo CREATE PARTITION PRIMARY",
    ">>X:\\diskpart-crucible.txt echo FORMAT QUICK FS=NTFS LABEL=Windows",
    ">>X:\\diskpart-crucible.txt echo ASSIGN LETTER=W",
    "diskpart /s X:\\diskpart-crucible.txt || (pause & exit /b 1)",
    "dism /Apply-Image /ImageFile:%IMAGE_FILE% /Index:1 /ApplyDir:W:\\ || (pause & exit /b 1)",
    "dism /Image:W:\\ /Add-Driver /Driver:%DRIVER_ROOT% /Recurse /ForceUnsigned || (pause & exit /b 1)",
    "bcdboot W:\\Windows /s S: /f UEFI || (pause & exit /b 1)",
    // Disable Windows Defender by editing the freshly-installed system
    // registry hive OFFLINE, before the OS ever boots. Tamper Protection
    // in Windows 11 25H2 silently overrides every Policy registry write
    // ('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\...') once
    // Defender has started up, but it cannot defend against an offline
    // SYSTEM-hive write that disables the filter driver before it ever
    // loads. WdFilter (the filesystem minifilter — not the user-mode
    // service) is the actual process that races qemu-ga's
    // GENERIC_WRITE / FILE_SHARE_READ guest-file-open against newly
    // created .ps1 files and produces ERROR_SHARING_VIOLATION; disabling
    // just WinDefend leaves the minifilter loaded. Setting Start=4
    // (SERVICE_DISABLED) on the boot-time / system-start services in
    // the offline hive guarantees the minifilter is never loaded into
    // the kernel on first boot, so the qga upload race in qga-ready
    // cannot happen. Re-enable / lock-down happens later via
    // configure-policy.ps1 once provisioning has staged the agent.
    "reg load HKLM\\OFF_SYS W:\\Windows\\System32\\config\\SYSTEM || (pause & exit /b 1)",
    'reg add "HKLM\\OFF_SYS\\ControlSet001\\Services\\WinDefend" /v Start /t REG_DWORD /d 4 /f',
    'reg add "HKLM\\OFF_SYS\\ControlSet001\\Services\\WdFilter" /v Start /t REG_DWORD /d 4 /f',
    'reg add "HKLM\\OFF_SYS\\ControlSet001\\Services\\WdNisSvc" /v Start /t REG_DWORD /d 4 /f',
    'reg add "HKLM\\OFF_SYS\\ControlSet001\\Services\\WdNisDrv" /v Start /t REG_DWORD /d 4 /f',
    'reg add "HKLM\\OFF_SYS\\ControlSet001\\Services\\WdBoot" /v Start /t REG_DWORD /d 4 /f',
    'reg add "HKLM\\OFF_SYS\\ControlSet001\\Services\\Sense" /v Start /t REG_DWORD /d 4 /f',
    'reg add "HKLM\\OFF_SYS\\ControlSet001\\Services\\SecurityHealthService" /v Start /t REG_DWORD /d 4 /f',
    "reg unload HKLM\\OFF_SYS || (pause & exit /b 1)",
    "mkdir W:\\Windows\\Panther",
    "copy %ANSWER_FILE% W:\\Windows\\Panther\\Unattend.xml",
    "mkdir W:\\Windows\\Setup\\Scripts",
    "for %%d in (C D E F G H I J K L M N O P Q R S T U V W X Y Z) do if exist %%d:\\$OEM$\\$$\\Setup\\Scripts\\SetupComplete.cmd copy %%d:\\$OEM$\\$$\\Setup\\Scripts\\SetupComplete.cmd W:\\Windows\\Setup\\Scripts\\SetupComplete.cmd",
    "wpeutil reboot",
    `rem virtio profile ${osFolder}`,
  ].join("\r\n");
}

function buildSetupCompleteScript(): string {
  return [
    "@echo off",
    "if exist D:\\guest-agent\\qemu-ga-x86_64.msi msiexec /i D:\\guest-agent\\qemu-ga-x86_64.msi /qn",
    "if exist E:\\guest-agent\\qemu-ga-x86_64.msi msiexec /i E:\\guest-agent\\qemu-ga-x86_64.msi /qn",
    "if exist F:\\guest-agent\\qemu-ga-x86_64.msi msiexec /i F:\\guest-agent\\qemu-ga-x86_64.msi /qn",
  ].join("\r\n");
}

async function copyVirtioDriverDirectories(options: {
  readonly virtioIsoPath: string;
  readonly bootDirectory: string;
  readonly profile: CrucibleConfig["media"]["profile"];
  readonly processRunner: ProcessRunner;
  readonly timeoutMs: number;
}): Promise<void> {
  const osFolder = options.profile === "windows-server-2025-eval" ? "2k25" : "w11";
  const driverRoot = path.join(options.bootDirectory, "drivers");
  await mkdir(driverRoot, { recursive: true });

  for (const driver of ["vioscsi", "NetKVM", "vioserial"] as const) {
    const destination = path.join(driverRoot, driver);
    await chmodTreeWritable(destination);
    await rm(destination, { recursive: true, force: true });
    await runProvisioningProcess(options.processRunner, {
      executable: "xorriso",
      args: [
        "-osirrox",
        "on",
        "-indev",
        options.virtioIsoPath,
        "-extract",
        `/${driver}/${osFolder}/amd64`,
        destination,
      ],
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 1024 * 1024,
    });
    await chmodTreeWritable(destination);
  }
}

async function chmodTreeWritable(targetPath: string): Promise<void> {
  try {
    const info = await lstat(targetPath);
    if (!info.isDirectory()) {
      await chmod(targetPath, 0o644);
      return;
    }
    await chmod(targetPath, 0o755);
    const entries = await readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      await chmodTreeWritable(path.join(targetPath, entry.name));
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function assertReadableFile(label: string, filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error(`${label} path is not a file`);
    }
  } catch (error) {
    throw new CrucibleError("MEDIA_UNAVAILABLE", `${label} is not readable: ${filePath}`, error);
  }
}

async function assertReadableDirectory(label: string, dirPath: string): Promise<void> {
  try {
    const info = await stat(dirPath);
    if (!info.isDirectory()) {
      throw new Error(`${label} path is not a directory`);
    }
  } catch (error) {
    throw new CrucibleError("MEDIA_UNAVAILABLE", `${label} is not readable: ${dirPath}`, error);
  }
}

async function runProvisioningProcess(
  processRunner: ProcessRunner,
  command: ProcessCommand,
): Promise<void> {
  const result = await processRunner.run(command);
  if (result.exitCode !== 0 || result.timedOut) {
    const argv = [command.executable, ...command.args].join(" ");
    const stderrPreview = (result.stderr ?? "").slice(0, 800).trim();
    throw new CrucibleError(
      "PROCESS_FAILED",
      `Provisioning host command failed: ${argv} (exit=${result.exitCode ?? "none"} timedOut=${result.timedOut}${stderrPreview !== "" ? `, stderr: ${stderrPreview}` : ""})`,
      {
        command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stderr: result.stderr,
      },
    );
  }
}

export function buildGuestHealthReport(options: {
  readonly config?: CrucibleConfig;
  readonly lifecycleStatus: VmStatus;
  readonly plan?: ProvisioningPlan;
  readonly now?: () => Date;
}): GuestHealthReport {
  const config = options.config ?? defaultCrucibleConfig;
  const plan =
    options.plan ??
    buildProvisioningPlan({
      vmName: config.vm.name,
      secretsDirectory: config.artifacts.secretsDirectory,
      controlPort: config.network.controlPort,
      guestAddress: getGuestControlAddress(config),
      analysisPolicy: config.analysisPolicy,
    });
  const healthStage = requiredStage(plan, "health-checked");
  const checks: GuestHealthCheckResult[] = healthStage.readinessChecks.map((check) => ({
    ...check,
    status: options.lifecycleStatus.qmpAvailable ? "unknown" : "fail",
    detail: options.lifecycleStatus.qmpAvailable
      ? "requires guest agent health endpoint execution on the provisioned VM"
      : "QMP is unavailable; guest health cannot be confirmed",
  }));
  const status = checks.some((check) => check.status === "fail")
    ? "unavailable"
    : checks.some((check) => check.status === "unknown")
      ? "degraded"
      : "healthy";

  return {
    vmName: config.vm.name,
    status,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    lifecycleStatus: options.lifecycleStatus.status,
    qmpAvailable: options.lifecycleStatus.qmpAvailable,
    vmProcessAlive: options.lifecycleStatus.processAlive,
    controlEndpoint: `127.0.0.1:${config.network.controlPort}`,
    checks,
  };
}

function getGuestControlAddress(config: CrucibleConfig): string {
  const plan = buildNetworkPlan({
    config: config.network,
    vmName: config.vm.name,
    networkDevice: config.virtio.networkDevice,
  });
  const controlForward = plan.qemu.portForwards[0];
  if (controlForward === undefined) {
    throw new Error("Network plan did not provide a guest control address");
  }
  return controlForward.guestAddress;
}

export function createInitialProvisioningStateMachine(): ProvisioningStateMachine {
  return {
    version: 1,
    status: "notStarted",
    stages: PROVISIONING_STAGE_IDS.map((id) => ({ id, status: "pending" })),
    transitions: PROVISIONING_STAGE_TRANSITIONS,
  };
}

export function canAdvanceProvisioningStage(
  from: ProvisioningStageId | "start",
  to: ProvisioningStageId | "complete",
): boolean {
  return PROVISIONING_STAGE_TRANSITIONS.some(
    (transition) => transition.from === from && transition.onSuccess === to,
  );
}

export function buildProvisioningSecretStorageContract(
  vmName: string,
  secretsDirectory: string,
): ProvisioningSecretStorageContract {
  const vmSecretsDirectory = path.join(secretsDirectory, sanitizeSecretPathPart(vmName));

  return {
    rootDirectory: vmSecretsDirectory,
    manifestArtifactKind: "credential",
    redactedResultFields: ["password", "privateKey", "certificatePem", "pfxPassword"],
    secretRefs: [
      secretRef("windows-standard-password", "windows/standard-user.json", "json", "standard"),
      secretRef("windows-admin-password", "windows/admin-user.json", "json", "admin"),
      secretRef("mtls-ca-private-key", "mtls/ca.key.pem", "pem", "ca"),
      secretRef("mtls-ca-certificate", "mtls/ca.cert.pem", "pem", "ca"),
      secretRef("mtls-host-client-private-key", "mtls/host-client.key.pem", "pem", "host"),
      secretRef("mtls-host-client-certificate", "mtls/host-client.cert.pem", "pem", "host"),
      secretRef("mtls-guest-server-private-key", "mtls/guest-server.key.pem", "pem", "guest"),
      secretRef("mtls-guest-server-certificate", "mtls/guest-server.cert.pem", "pem", "guest"),
    ].map((ref) => ({ ...ref, path: path.join(vmSecretsDirectory, ref.path) })),
  };
}

function buildProvisioningStageContracts(
  options: ProvisioningPlanOptions,
): readonly ProvisioningStageContract[] {
  return [
    {
      id: "media-ready",
      title: "Media readiness",
      dependsOn: [],
      readinessChecks: [
        requiredCheck(
          "windows-install-media",
          "Windows installation media is present or overridden",
        ),
        requiredCheck("virtio-media", "virtio driver media is present or overridden"),
      ],
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "vm-booted",
      title: "VM boot",
      dependsOn: ["media-ready"],
      readinessChecks: [
        requiredCheck("qmp-running", "QMP reports the VM is running"),
        requiredCheck("qga-channel-present", "QGA virtio serial channel is configured"),
      ],
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "qga-ready",
      title: "QGA readiness",
      dependsOn: ["vm-booted"],
      readinessChecks: [
        requiredCheck("guest-ping", "QGA guest-ping responds before bootstrap scripts run"),
        requiredCheck(
          "powershell-available",
          "PowerShell is available through QGA command execution",
        ),
      ],
      script: script("probe-qga", "qga-powershell", "guest/provision/probe-qga.ps1"),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "windbg-installed",
      title: "WinDbg and CDB installation",
      dependsOn: ["qga-ready"],
      readinessChecks: [
        requiredCheck("cdb-path", "CDB is discoverable on the guest"),
        requiredCheck("windbg-path", "WinDbg is discoverable on the guest"),
        requiredCheck("kd-path", "KD is discoverable on the guest"),
        requiredCheck("kdnet-path", "KDNET is discoverable on the guest"),
        requiredCheck("gflags-path", "GFlags is discoverable on the guest"),
        requiredCheck("symbol-path", "Default symbol path is configured"),
        requiredCheck("symbol-cache-writable", "Default symbol cache is writable"),
      ],
      script: script("install-windbg", "qga-powershell", "guest/provision/install-windbg.ps1", {
        scriptArguments: ["-AllowSkipOnNetworkFailure"],
        timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
        elevated: true,
      }),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "analysis-tools-installed",
      title: "Analysis tooling installation",
      dependsOn: ["windbg-installed"],
      readinessChecks: [
        requiredCheck(
          "sysinternals-reported",
          "Sysinternals availability is installed or reported",
        ),
        requiredCheck(
          "dynamic-tools-reported",
          "Dynamic malware-analysis tool availability is installed or reported",
        ),
      ],
      script: script(
        "install-analysis-tools",
        "qga-powershell",
        "guest/provision/install-analysis-tools.ps1",
        {
          scriptArguments: ["-AllowSkipOnNetworkFailure"],
          timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
          elevated: true,
        },
      ),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "local-accounts-created",
      title: "Local execution accounts",
      dependsOn: ["analysis-tools-installed"],
      readinessChecks: [
        requiredCheck("standard-account", "Standard execution account exists and can log on"),
        requiredCheck("admin-account", "Admin execution account exists and can run elevated tasks"),
      ],
      script: script(
        "create-local-accounts",
        "guest-agent-powershell",
        "guest/provision/create-local-accounts.ps1",
        {
          elevated: true,
          environmentSecretRefs: ["windows-standard-password", "windows-admin-password"],
        },
      ),
      producesSecrets: ["windows-standard-password", "windows-admin-password"],
      producesSnapshot: false,
    },
    {
      id: "guest-agent-installed",
      title: "Guest agent installation",
      dependsOn: ["local-accounts-created"],
      readinessChecks: [
        requiredCheck("service-installed", "Crucible guest service is installed"),
        requiredCheck("service-running", "Crucible guest service is running"),
        requiredCheck("host-only-firewall", "Guest firewall allows only host-only control traffic"),
      ],
      script: script("install-guest-agent", "qga-powershell", "guest/provision/install-agent.ps1", {
        scriptArguments: [
          "-ServiceName",
          "CrucibleGuestAgent",
          "-ControlAddress",
          options.guestAddress,
          "-HostOnlySourceAddress",
          "192.0.2.1",
          "-ControlPort",
          String(options.controlPort),
        ],
        timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
        elevated: true,
        environmentSecretRefs: ["windows-standard-password", "windows-admin-password"],
      }),
      producesSecrets: [
        "mtls-ca-private-key",
        "mtls-ca-certificate",
        "mtls-host-client-private-key",
        "mtls-host-client-certificate",
        "mtls-guest-server-private-key",
        "mtls-guest-server-certificate",
      ],
      producesSnapshot: false,
    },
    {
      id: "policy-configured",
      title: "Analysis VM policy changes",
      dependsOn: ["guest-agent-installed"],
      readinessChecks: [
        requiredCheck("defender-disabled", "Defender disabled state is recorded"),
        requiredCheck("code-integrity-recorded", "Code-integrity policy state is recorded"),
        requiredCheck(
          "test-signing-disabled",
          "Test signing is disabled unless explicitly overridden",
        ),
        requiredCheck(
          "analysis-profile-audited",
          "Analysis VM environment profile settings are recorded",
        ),
      ],
      script: script(
        "configure-analysis-policy",
        "guest-agent-powershell",
        "guest/provision/configure-policy.ps1",
        {
          scriptArguments: buildAnalysisVmPolicyScriptArguments(
            options.analysisPolicy ?? defaultAnalysisVmPolicyConfig,
          ),
          elevated: true,
        },
      ),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "health-checked",
      title: "Provisioning health checks",
      dependsOn: ["local-accounts-created"],
      readinessChecks: [
        requiredCheck(
          "debugger-health",
          "Debugger, symbol-cache, and dynamic analysis tooling readiness is reported",
        ),
        requiredCheck("service-health", "Guest service health endpoint is healthy"),
        requiredCheck("execution-contexts", "Standard and admin execution contexts are healthy"),
        requiredCheck(
          "policy-health",
          "Defender, code-integrity, and test-signing states are reported",
        ),
      ],
      script: script(
        "test-provisioning-health",
        "guest-agent-powershell",
        "guest/provision/test-health.ps1",
        {
          scriptArguments: ["-AllowMissingWinDbg", "-AllowDefenderEnabled"],
        },
      ),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "snapshot-prepared",
      title: "Snapshot preparation",
      dependsOn: ["health-checked"],
      readinessChecks: [
        requiredCheck("guest-quiesced", "Guest transient state is quiesced before clean snapshot"),
        requiredCheck(
          "snapshot-metadata",
          "Clean snapshot metadata can be written to the artifact manifest",
        ),
      ],
      script: script(
        "prepare-snapshot",
        "guest-agent-powershell",
        "guest/provision/prepare-snapshot.ps1",
        {
          scriptArguments: ["-SnapshotName", options.snapshotName ?? "clean-base"],
          elevated: true,
        },
      ),
      producesSecrets: [],
      producesSnapshot: true,
    },
  ];
}

function requiredCheck(id: string, description: string): ProvisioningReadinessCheck {
  return { id, description, required: true };
}

function requiredStage(plan: ProvisioningPlan, id: ProvisioningStageId): ProvisioningStageContract {
  const stage = plan.stages.find((entry) => entry.id === id);
  if (stage === undefined) {
    throw new Error(`Missing provisioning stage: ${id}`);
  }
  return stage;
}

const blockedProvisioningExecutor: ProvisioningExecutor = {
  runStage(stage) {
    return Promise.resolve({
      id: stage.id,
      title: stage.title,
      status: "blocked",
      detail:
        "real Windows provisioning execution requires configured QGA and guest-agent adapters; CI uses fakes only",
    });
  },
};

function script(
  id: string,
  runner: ProvisioningScriptRunner,
  scriptPath: string,
  overrides: Partial<
    Pick<
      ProvisioningScriptInvocationContract,
      "timeoutMs" | "elevated" | "redactedArgumentIndexes" | "environmentSecretRefs"
    >
  > & {
    readonly scriptArguments?: readonly string[];
  } = {},
): ProvisioningScriptInvocationContract {
  const { scriptArguments, ...contractOverrides } = overrides;

  return {
    id,
    runner,
    executable: POWERSHELL,
    scriptPath,
    arguments: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...(scriptArguments ?? []),
    ],
    timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
    elevated: false,
    redactedArgumentIndexes: [],
    environmentSecretRefs: [],
    ...contractOverrides,
  };
}

export async function writeWindowsAccountSecrets(
  options: WindowsAccountSecretOptions,
): Promise<WindowsAccountSecretWriteResult> {
  const contract = buildProvisioningSecretStorageContract(options.vmName, options.secretsDirectory);
  const standardRef = requiredSecretRef(contract, "windows-standard-password");
  const adminRef = requiredSecretRef(contract, "windows-admin-password");
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const passwordLength = options.passwordLength ?? 32;
  const random = options.randomBytes ?? randomBytes;
  const accounts = [
    {
      ref: standardRef,
      secret: {
        username: options.standardUsername ?? "CrucibleUser",
        password: generatePassword(passwordLength, random),
        principal: "standard" as const,
        generatedAt,
      },
    },
    {
      ref: adminRef,
      secret: {
        username: options.adminUsername ?? "CrucibleAdmin",
        password: generatePassword(passwordLength, random),
        principal: "admin" as const,
        generatedAt,
      },
    },
  ];

  for (const account of accounts) {
    await mkdir(path.dirname(account.ref.path), { recursive: true, mode: 0o700 });
    await writeFile(account.ref.path, `${JSON.stringify(account.secret, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(account.ref.path, 0o600);
  }

  return {
    rootDirectory: contract.rootDirectory,
    accounts: accounts.map(({ ref, secret }) => ({
      username: secret.username,
      principal: secret.principal,
      path: ref.path,
      fileMode: ref.fileMode,
    })),
  };
}

export function buildGuestAgentCertificateStagePlan(
  options: Pick<ProvisioningPlanOptions, "vmName" | "secretsDirectory"> & {
    readonly guestStagingDirectory?: string;
  },
): GuestAgentCertificateStagePlan {
  const contract = buildProvisioningSecretStorageContract(options.vmName, options.secretsDirectory);
  const guestStagingDirectory =
    options.guestStagingDirectory ?? "C:\\ProgramData\\Crucible\\Agent\\certs";

  return {
    caCertificateSecretPath: requiredSecretRef(contract, "mtls-ca-certificate").path,
    guestServerCertificateSecretPath: requiredSecretRef(contract, "mtls-guest-server-certificate")
      .path,
    guestServerPrivateKeySecretPath: requiredSecretRef(contract, "mtls-guest-server-private-key")
      .path,
    guestStagingDirectory,
    stagedCaCertificatePath: `${guestStagingDirectory}\\ca.cert.pem`,
    stagedServerCertificatePath: `${guestStagingDirectory}\\guest-server.cert.pem`,
    stagedServerPrivateKeyPath: `${guestStagingDirectory}\\guest-server.key.pem`,
  };
}

function requiredSecretRef(
  contract: ProvisioningSecretStorageContract,
  kind: ProvisioningSecretKind,
): ProvisioningSecretRef {
  const ref = contract.secretRefs.find((entry) => entry.kind === kind);

  if (ref === undefined) {
    throw new Error(`Missing provisioning secret reference: ${kind}`);
  }

  return ref;
}

function generatePassword(length: number, random: (size: number) => Buffer): string {
  if (length < 24) {
    throw new Error("Windows account passwords must be at least 24 characters");
  }

  const requiredCharacters = [
    pickPasswordCharacter(PASSWORD_UPPER, random(1)[0] ?? 0),
    pickPasswordCharacter(PASSWORD_LOWER, random(1)[0] ?? 0),
    pickPasswordCharacter(PASSWORD_DIGIT, random(1)[0] ?? 0),
    pickPasswordCharacter(PASSWORD_SYMBOL, random(1)[0] ?? 0),
  ];
  const remaining = Array.from(random(length - requiredCharacters.length), (byte) =>
    pickPasswordCharacter(PASSWORD_ALPHABET, byte),
  );
  const characters = [...requiredCharacters, ...remaining];
  const shuffleBytes = random(characters.length);

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = (shuffleBytes[index] ?? 0) % (index + 1);
    [characters[index], characters[swapIndex]] = [
      characters[swapIndex] ?? "",
      characters[index] ?? "",
    ];
  }

  return characters.join("");
}

function pickPasswordCharacter(alphabet: string, byte: number): string {
  return alphabet[byte % alphabet.length] ?? alphabet[0] ?? "A";
}

function secretRef(
  kind: ProvisioningSecretKind,
  relativePath: string,
  format: ProvisioningSecretRef["format"],
  principal: ProvisioningSecretRef["principal"],
): ProvisioningSecretRef {
  return {
    kind,
    id: kind,
    path: relativePath,
    fileMode: "0600",
    format,
    principal,
  };
}

function sanitizeSecretPathPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "vm"
  );
}
