import { randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildAnalysisVmPolicyScriptArguments,
  defaultAnalysisVmPolicyConfig,
  type AnalysisVmPolicyConfig,
} from "./analysis-policy.js";
import { defaultCrucibleConfig, type CrucibleConfig } from "./config.js";
import { CrucibleError } from "./errors.js";
import { type VmLifecycleManager, type VmStatus } from "./lifecycle.js";
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
  "guest-agent-installed",
  "policy-configured",
  "local-accounts-created",
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
  readonly timeoutMs?: number;
};

export type RealFirstBootProvisioningPlan = {
  readonly diskPath: string;
  readonly ovmfCodePath: string;
  readonly ovmfVarsPath: string;
  readonly swtpmSocketPath: string;
  readonly swtpmPidPath: string;
  readonly swtpmStateDirectory: string;
  readonly autounattendIsoPath: string;
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

const POWERSHELL = "powershell.exe";
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
  { from: "windbg-installed", onSuccess: "guest-agent-installed", onFailure: "blocked" },
  { from: "guest-agent-installed", onSuccess: "policy-configured", onFailure: "blocked" },
  { from: "policy-configured", onSuccess: "local-accounts-created", onFailure: "blocked" },
  { from: "local-accounts-created", onSuccess: "health-checked", onFailure: "blocked" },
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
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const qmp = new QmpClient({
      socketPath: config.qmp.socketPath,
      timeoutMs: config.qmp.timeoutMs,
    });
    try {
      await qmp.connect();
      for (let index = 0; index < 20; index += 1) {
        await qmp.execute("human-monitor-command", {
          "command-line": "sendkey ret",
        });
        await sleep(250);
      }
      return;
    } catch {
      await sleep(500);
    } finally {
      qmp.close();
    }
  }
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
  await mkdir(bootDirectory, { recursive: true });
  await mkdir(swtpmStateDirectory, { recursive: true });
  if (!(await pathExists(ovmfVarsPath))) {
    await copyFile(ovmfVarsTemplatePath, ovmfVarsPath);
  }
  await writeFile(
    path.join(bootDirectory, "Autounattend.xml"),
    buildAutounattendXml(config),
    "utf8",
  );
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

  return {
    diskPath: plan.disk.path,
    ovmfCodePath,
    ovmfVarsPath,
    swtpmSocketPath,
    swtpmPidPath,
    swtpmStateDirectory,
    autounattendIsoPath,
    commands,
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

function buildAutounattendXml(config: CrucibleConfig): string {
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
    '  <settings pass="oobeSystem">',
    '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    `      <ComputerName>${escapeXml(config.vm.name.slice(0, 15))}</ComputerName>`,
    "      <OOBE><HideEULAPage>true</HideEULAPage><ProtectYourPC>3</ProtectYourPC></OOBE>",
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

async function runProvisioningProcess(
  processRunner: ProcessRunner,
  command: ProcessCommand,
): Promise<void> {
  const result = await processRunner.run(command);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new CrucibleError("PROCESS_FAILED", "Provisioning host command failed", {
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stderr: result.stderr,
    });
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
        requiredCheck("symbol-path", "Default symbol path is configured"),
      ],
      script: script("install-windbg", "qga-powershell", "guest/provision/install-windbg.ps1", {
        timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
        elevated: true,
      }),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "guest-agent-installed",
      title: "Guest agent installation",
      dependsOn: ["windbg-installed"],
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
      id: "local-accounts-created",
      title: "Local execution accounts",
      dependsOn: ["policy-configured"],
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
      id: "health-checked",
      title: "Provisioning health checks",
      dependsOn: ["local-accounts-created"],
      readinessChecks: [
        requiredCheck("debugger-health", "CDB and WinDbg readiness is reported"),
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
