import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCrucibleConfig } from "./config.js";
import { buildLifecyclePaths, type VmStatus } from "./lifecycle.js";
import {
  buildGuestAgentCertificateStagePlan,
  buildGuestHealthReport,
  buildProvisioningPlan,
  buildProvisioningSecretStorageContract,
  canAdvanceProvisioningStage,
  createInitialProvisioningStateMachine,
  prepareRealFirstBootProvisioning,
  PROVISIONING_SECRET_KINDS,
  PROVISIONING_STAGE_IDS,
  runProvisioningCommand,
  writeWindowsAccountSecrets,
} from "./provisioning.js";
import type { ProcessCommand, ProcessRunner } from "./process.js";

describe("provisioning contracts", () => {
  it("defines the Phase 3 provisioning stages in execution order", () => {
    expect(PROVISIONING_STAGE_IDS).toEqual([
      "media-ready",
      "vm-booted",
      "qga-ready",
      "windbg-installed",
      "guest-agent-installed",
      "policy-configured",
      "local-accounts-created",
      "health-checked",
      "snapshot-prepared",
    ]);
  });

  it("creates a deterministic initial state machine", () => {
    const stateMachine = createInitialProvisioningStateMachine();

    expect(stateMachine).toMatchObject({
      version: 1,
      status: "notStarted",
    });
    const completeStatus: typeof stateMachine.status = "complete";
    expect(completeStatus).toBe("complete");
    expect(stateMachine.currentStageId).toBeUndefined();
    expect(stateMachine.stages.map((stage) => stage.status)).toEqual(
      PROVISIONING_STAGE_IDS.map(() => "pending"),
    );
    expect(stateMachine.transitions).toEqual([
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
    ]);
  });

  it("allows only declared success transitions", () => {
    expect(canAdvanceProvisioningStage("start", "media-ready")).toBe(true);
    expect(canAdvanceProvisioningStage("media-ready", "vm-booted")).toBe(true);
    expect(canAdvanceProvisioningStage("media-ready", "qga-ready")).toBe(false);
    expect(canAdvanceProvisioningStage("snapshot-prepared", "complete")).toBe(true);
  });

  it("builds stage contracts without executing provisioning", () => {
    const plan = buildProvisioningPlan({
      vmName: "analysis one",
      secretsDirectory: "secrets",
      controlPort: 9443,
      guestAddress: "192.0.2.2",
      snapshotName: "baseline",
    });

    expect(plan.version).toBe(1);
    expect(plan.vmName).toBe("analysis one");
    expect(plan.stages.map((stage) => stage.id)).toEqual(PROVISIONING_STAGE_IDS);
    expect(
      plan.stages.every((stage) => stage.readinessChecks.every((check) => check.required)),
    ).toBe(true);

    const windbg = plan.stages.find((stage) => stage.id === "windbg-installed");
    expect(windbg?.script).toEqual(
      expect.objectContaining({
        id: "install-windbg",
        runner: "qga-powershell",
        executable: "powershell.exe",
        scriptPath: "guest/provision/install-windbg.ps1",
        elevated: true,
        timeoutMs: 2_700_000,
      }),
    );
    expect(windbg?.script?.arguments).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "guest/provision/install-windbg.ps1",
    ]);

    const guestAgent = plan.stages.find((stage) => stage.id === "guest-agent-installed");
    expect(guestAgent?.script?.arguments).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "guest/provision/install-agent.ps1",
      "-ServiceName",
      "CrucibleGuestAgent",
      "-ControlAddress",
      "192.0.2.2",
      "-HostOnlySourceAddress",
      "192.0.2.1",
      "-ControlPort",
      "9443",
    ]);
    expect(guestAgent?.producesSecrets).toEqual([
      "mtls-ca-private-key",
      "mtls-ca-certificate",
      "mtls-host-client-private-key",
      "mtls-host-client-certificate",
      "mtls-guest-server-private-key",
      "mtls-guest-server-certificate",
    ]);

    const policy = plan.stages.find((stage) => stage.id === "policy-configured");
    expect(policy?.script).toEqual(
      expect.objectContaining({
        id: "configure-analysis-policy",
        runner: "guest-agent-powershell",
        scriptPath: "guest/provision/configure-policy.ps1",
        elevated: true,
      }),
    );
    expect(policy?.script?.arguments).toContain("-RequireTestSigningDisabled");
    expect(policy?.script?.arguments).toContain("-CommonAnalysisLabCamouflage");
    expect(policy?.readinessChecks.map((check) => check.id)).toEqual([
      "defender-disabled",
      "code-integrity-recorded",
      "test-signing-disabled",
      "analysis-profile-audited",
    ]);

    const localAccounts = plan.stages.find((stage) => stage.id === "local-accounts-created");
    expect(localAccounts?.producesSecrets).toEqual([
      "windows-standard-password",
      "windows-admin-password",
    ]);
    expect(localAccounts?.script?.environmentSecretRefs).toEqual([
      "windows-standard-password",
      "windows-admin-password",
    ]);
    expect(localAccounts?.script?.arguments).not.toContain("windows-standard-password");
    expect(localAccounts?.script?.arguments).not.toContain("windows-admin-password");

    const snapshot = plan.stages.find((stage) => stage.id === "snapshot-prepared");
    expect(snapshot?.producesSnapshot).toBe(true);
    expect(snapshot?.script?.arguments).toContain("baseline");
  });

  it("passes optional analysis profile settings to policy provisioning", () => {
    const plan = buildProvisioningPlan({
      vmName: "analysis one",
      secretsDirectory: "secrets",
      controlPort: 9443,
      guestAddress: "192.0.2.2",
      analysisPolicy: {
        isolatedAnalysisVm: true,
        disableDefender: true,
        disableCodeIntegrity: true,
        requireTestSigningDisabled: true,
        profile: {
          hostname: "DESKTOP-7F3K9Q2",
          username: "analyst",
          locale: "en-GB",
          screenSize: "1366x768",
          disableSleep: true,
          showFileExtensions: true,
          showHiddenFiles: true,
          showExplorerRibbon: true,
          clearRecentExplorerHistory: true,
          commonAnalysisLabCamouflage: true,
        },
      },
    });

    expect(
      plan.stages.find((stage) => stage.id === "policy-configured")?.script?.arguments,
    ).toEqual(
      expect.arrayContaining([
        "-Hostname",
        "DESKTOP-7F3K9Q2",
        "-ProfileUsername",
        "analyst",
        "-Locale",
        "en-GB",
        "-ScreenSize",
        "1366x768",
        "-CommonAnalysisLabCamouflage",
        "$true",
      ]),
    );
  });

  it("defines host-only secret references for Windows credentials and mTLS material", () => {
    const secrets = buildProvisioningSecretStorageContract(
      "Analysis VM!",
      "/var/lib/crucible/secrets",
    );

    expect(PROVISIONING_SECRET_KINDS).toHaveLength(8);
    expect(secrets.rootDirectory).toBe("/var/lib/crucible/secrets/analysis-vm");
    expect(secrets.manifestArtifactKind).toBe("credential");
    expect(secrets.redactedResultFields).toEqual([
      "password",
      "privateKey",
      "certificatePem",
      "pfxPassword",
    ]);
    expect(secrets.secretRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "windows-standard-password",
          path: "/var/lib/crucible/secrets/analysis-vm/windows/standard-user.json",
          fileMode: "0600",
          format: "json",
          principal: "standard",
        }),
        expect.objectContaining({
          kind: "windows-admin-password",
          path: "/var/lib/crucible/secrets/analysis-vm/windows/admin-user.json",
          fileMode: "0600",
          format: "json",
          principal: "admin",
        }),
        expect.objectContaining({ kind: "mtls-ca-private-key", principal: "ca" }),
        expect.objectContaining({ kind: "mtls-host-client-certificate", principal: "host" }),
        expect.objectContaining({ kind: "mtls-guest-server-private-key", principal: "guest" }),
      ]),
    );
    expect(secrets.secretRefs.every((ref) => ref.path.startsWith(secrets.rootDirectory))).toBe(
      true,
    );
  });

  it("writes generated Windows account credentials only under host secrets", async () => {
    const root = await mkdtempPath();
    let counter = 0;
    const result = await writeWindowsAccountSecrets({
      vmName: "Analysis VM!",
      secretsDirectory: join(root, "secrets"),
      passwordLength: 24,
      generatedAt: new Date("2026-05-27T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, counter++),
    });

    expect(result.rootDirectory).toBe(join(root, "secrets", "analysis-vm"));
    expect(result.accounts).toEqual([
      expect.objectContaining({
        username: "CrucibleUser",
        principal: "standard",
        path: join(root, "secrets", "analysis-vm", "windows", "standard-user.json"),
        fileMode: "0600",
      }),
      expect.objectContaining({
        username: "CrucibleAdmin",
        principal: "admin",
        path: join(root, "secrets", "analysis-vm", "windows", "admin-user.json"),
        fileMode: "0600",
      }),
    ]);

    const standard = JSON.parse(await readFile(result.accounts[0]?.path ?? "", "utf8")) as {
      password: string;
      principal: string;
      generatedAt: string;
    };
    const admin = JSON.parse(await readFile(result.accounts[1]?.path ?? "", "utf8")) as {
      password: string;
      principal: string;
      generatedAt: string;
    };

    expect(standard).toMatchObject({
      principal: "standard",
      generatedAt: "2026-05-27T00:00:00.000Z",
    });
    expect(admin).toMatchObject({ principal: "admin", generatedAt: "2026-05-27T00:00:00.000Z" });
    expect(standard.password).toHaveLength(24);
    expect(admin.password).toHaveLength(24);
    expect(standard.password).not.toBe(admin.password);

    const mode = (await stat(result.accounts[0]?.path ?? "")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("builds a deterministic guest certificate staging plan from host secrets", () => {
    const plan = buildGuestAgentCertificateStagePlan({
      vmName: "analysis one",
      secretsDirectory: "/var/lib/crucible/secrets",
    });

    expect(plan).toEqual({
      caCertificateSecretPath: "/var/lib/crucible/secrets/analysis-one/mtls/ca.cert.pem",
      guestServerCertificateSecretPath:
        "/var/lib/crucible/secrets/analysis-one/mtls/guest-server.cert.pem",
      guestServerPrivateKeySecretPath:
        "/var/lib/crucible/secrets/analysis-one/mtls/guest-server.key.pem",
      guestStagingDirectory: "C:\\ProgramData\\Crucible\\Agent\\certs",
      stagedCaCertificatePath: "C:\\ProgramData\\Crucible\\Agent\\certs\\ca.cert.pem",
      stagedServerCertificatePath: "C:\\ProgramData\\Crucible\\Agent\\certs\\guest-server.cert.pem",
      stagedServerPrivateKeyPath: "C:\\ProgramData\\Crucible\\Agent\\certs\\guest-server.key.pem",
    });
  });

  it("runs the provision command workflow with fake real-VM adapters", async () => {
    const config = parseCrucibleConfig({ vm: { name: "analysis-one" } });
    const stages: string[] = [];
    const result = await runProvisioningCommand({
      config,
      lifecycleManager: {
        start: () => Promise.resolve({ pid: 1234, status: fakeVmStatus(config, true) }),
        status: () => Promise.resolve(fakeVmStatus(config, true)),
      },
      executor: {
        runStage(stage) {
          stages.push(stage.id);
          return Promise.resolve({
            id: stage.id,
            title: stage.title,
            status: "succeeded",
            detail: stage.script?.scriptPath ?? "readiness contract",
          });
        },
      },
      snapshotManager: {
        create: (snapshotName) =>
          Promise.resolve({
            snapshot: {
              kind: "snapshot",
              name: snapshotName,
              path: "artifacts/disks/analysis-one.qcow2",
              createdAt: "2026-05-27T00:00:00.000Z",
              baseDiskPath: "artifacts/disks/analysis-one.qcow2",
              clean: true,
              qemuTag: snapshotName,
              mode: "online-qmp",
            },
            qmpCommands: ["snapshot-save"],
            qcow2Commands: [],
          }),
      },
      skipBootKeyNudge: true,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
    });

    expect(result.status).toBe("complete");
    expect(stages).toEqual(PROVISIONING_STAGE_IDS);
    expect(result.snapshot?.snapshot.name).toBe("clean-base");
    expect(result.health.status).toBe("degraded");
    expect(result.health.checks.map((check) => check.id)).toEqual([
      "debugger-health",
      "service-health",
      "execution-contexts",
      "policy-health",
    ]);
  });

  it("blocks provision command workflow when real adapters are not configured", async () => {
    const config = parseCrucibleConfig({ vm: { name: "analysis-one" } });
    const result = await runProvisioningCommand({
      config,
      lifecycleManager: {
        start: () => Promise.resolve({ pid: 1234, status: fakeVmStatus(config, false) }),
        status: () => Promise.resolve(fakeVmStatus(config, false)),
      },
      snapshotManager: {
        create: () => {
          throw new Error("snapshot should not run after blocked stage");
        },
      },
      skipBootKeyNudge: true,
    });

    expect(result.status).toBe("blocked");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toEqual(
      expect.objectContaining({ id: "media-ready", status: "blocked" }),
    );
    expect(result.health.status).toBe("unavailable");
  });

  it("prepares first-boot host artifacts and commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-first-boot-"));
    const windowsIso = join(root, "windows.iso");
    const virtioIso = join(root, "virtio.iso");
    const ovmfCode = join(root, "OVMF_CODE.fd");
    const ovmfVars = join(root, "OVMF_VARS.fd");
    await Promise.all([
      writeFile(windowsIso, "windows", "utf8"),
      writeFile(virtioIso, "virtio", "utf8"),
      writeFile(ovmfCode, "code", "utf8"),
      writeFile(ovmfVars, "vars", "utf8"),
    ]);
    const commands: ProcessCommand[] = [];
    const processRunner: ProcessRunner = {
      run(command) {
        commands.push(command);
        return Promise.resolve({
          command,
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        });
      },
    };

    const plan = await prepareRealFirstBootProvisioning({
      config: parseCrucibleConfig({
        vm: { name: "first-boot", diskGiB: 64 },
        media: {
          windowsIso: { path: windowsIso },
          virtioIso: { path: virtioIso },
        },
        artifacts: {
          directory: join(root, "artifacts"),
          manifestPath: join(root, "artifacts", "manifest.json"),
          logsDirectory: join(root, "artifacts", "logs"),
          snapshotsDirectory: join(root, "snapshots"),
          secretsDirectory: join(root, "secrets"),
        },
      }),
      ovmfCodePath: ovmfCode,
      ovmfVarsTemplatePath: ovmfVars,
      processRunner,
    });

    expect(plan.diskPath).toContain("first-boot.qcow2");
    expect(plan.autounattendIsoPath).toContain("autounattend.iso");
    expect(commands.map((command) => command.executable)).toEqual([
      "xorriso",
      "xorriso",
      "xorriso",
      "qemu-img",
      "xorriso",
    ]);
    expect(commands[3]?.args).toEqual(["create", "-f", "qcow2", plan.diskPath, "64G"]);
    const autounattend = await readFile(
      join(root, "artifacts", "boot", "Autounattend.xml"),
      "utf8",
    );
    expect(autounattend).toContain("BypassTPMCheck");
    expect(autounattend).toContain("BypassSecureBootCheck");
    expect(autounattend).toContain("BypassRAMCheck");
    expect(autounattend).toContain("Microsoft-Windows-PnpCustomizationsWinPE");
    expect(autounattend).toContain("D:\\drivers\\vioscsi");
    expect(autounattend).toContain("<DiskID>0</DiskID>");
    expect(autounattend).toContain("/IMAGE/INDEX");
    const startup = await readFile(join(root, "artifacts", "boot", "startup.nsh"), "utf8");
    expect(startup).toContain("for %a in (fs0 fs1 fs2 fs3 fs4 fs5 fs6 fs7 fs8 fs9)");
    expect(startup).toContain("bootx64.efi");
  });

  it("does not overwrite existing disk or OVMF vars during first-boot preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-first-boot-existing-"));
    const windowsIso = join(root, "windows.iso");
    const virtioIso = join(root, "virtio.iso");
    const ovmfCode = join(root, "OVMF_CODE.fd");
    const ovmfVars = join(root, "OVMF_VARS.fd");
    const artifactDirectory = join(root, "artifacts");
    const diskDirectory = join(artifactDirectory, "disks");
    const bootDirectory = join(artifactDirectory, "boot");
    const diskPath = join(diskDirectory, "first-boot.qcow2");
    const existingVars = join(bootDirectory, "first-boot.OVMF_VARS.fd");
    await mkdir(diskDirectory, { recursive: true });
    await mkdir(bootDirectory, { recursive: true });
    await Promise.all([
      writeFile(windowsIso, "windows", "utf8"),
      writeFile(virtioIso, "virtio", "utf8"),
      writeFile(ovmfCode, "code", "utf8"),
      writeFile(ovmfVars, "vars", "utf8"),
      writeFile(diskPath, "existing disk", "utf8"),
      writeFile(existingVars, "existing vars", "utf8"),
    ]);
    const commands: ProcessCommand[] = [];

    await prepareRealFirstBootProvisioning({
      config: parseCrucibleConfig({
        vm: { name: "first-boot", diskGiB: 64 },
        media: {
          windowsIso: { path: windowsIso },
          virtioIso: { path: virtioIso },
        },
        artifacts: {
          directory: artifactDirectory,
          manifestPath: join(artifactDirectory, "manifest.json"),
          logsDirectory: join(artifactDirectory, "logs"),
          snapshotsDirectory: join(root, "snapshots"),
          secretsDirectory: join(root, "secrets"),
        },
      }),
      ovmfCodePath: ovmfCode,
      ovmfVarsTemplatePath: ovmfVars,
      processRunner: {
        run(command) {
          commands.push(command);
          return Promise.resolve({
            command,
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          });
        },
      },
    });

    expect(commands.map((command) => command.executable)).toEqual([
      "xorriso",
      "xorriso",
      "xorriso",
      "xorriso",
    ]);
    await expect(readFile(diskPath, "utf8")).resolves.toBe("existing disk");
    await expect(readFile(existingVars, "utf8")).resolves.toBe("existing vars");
  });

  it("builds guest health reports from provisioning readiness contracts", () => {
    const config = parseCrucibleConfig({ vm: { name: "analysis-one" } });
    const report = buildGuestHealthReport({
      config,
      lifecycleStatus: fakeVmStatus(config, false),
      now: () => new Date("2026-05-27T00:00:00.000Z"),
    });

    expect(report).toMatchObject({
      vmName: "analysis-one",
      status: "unavailable",
      generatedAt: "2026-05-27T00:00:00.000Z",
      qmpAvailable: false,
      vmProcessAlive: false,
      controlEndpoint: "127.0.0.1:8443",
    });
    expect(report.checks.map((check) => check.status)).toEqual(["fail", "fail", "fail", "fail"]);
  });

  it("keeps account provisioning secrets out of PowerShell argv", async () => {
    const script = await readFile("guest/provision/create-local-accounts.ps1", "utf8");

    expect(script).toContain("CRUCIBLE_STANDARD_PASSWORD");
    expect(script).toContain("CRUCIBLE_ADMIN_PASSWORD");
    expect(script).toContain("-PasswordNeverExpires:$true");
    expect(script).toContain("-UserMayChangePassword:$false");
    expect(script).not.toContain(
      "param(\n    [Parameter(Mandatory = $true)]\n    [string]$Password",
    );
    expect(script).not.toContain("-PasswordNeverExpires $true");
    expect(script).not.toContain("-UserMayChangePassword $false");
  });

  it("limits guest agent firewall setup to the host-only source address", async () => {
    const script = await readFile("guest/provision/install-agent.ps1", "utf8");

    expect(script).toContain("HostOnlySourceAddress");
    expect(script).toContain("[System.Net.IPAddress]::TryParse");
    expect(script).toContain("[System.Net.IPAddress]::Any");
    expect(script).toContain("[System.Net.IPAddress]::IPv6Any");
    expect(script).toContain("-RemoteAddress $HostOnlySourceAddress");
    expect(script).toContain("opensshBootstrapOnly = $true");
    expect(script).not.toContain("-RemoteAddress Any");
  });
});

async function mkdtempPath(): Promise<string> {
  return mkdtemp(join(tmpdir(), "crucible-provisioning-"));
}

function fakeVmStatus(
  config: ReturnType<typeof parseCrucibleConfig>,
  qmpAvailable: boolean,
): VmStatus {
  return {
    status: qmpAvailable ? "running" : "stopped",
    processAlive: qmpAvailable,
    qmpAvailable,
    qmpStatus: qmpAvailable ? "running" : undefined,
    paths: buildLifecyclePaths(config),
    warnings: [],
  };
}
