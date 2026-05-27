import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildGuestAgentCertificateStagePlan,
  buildProvisioningPlan,
  buildProvisioningSecretStorageContract,
  canAdvanceProvisioningStage,
  createInitialProvisioningStateMachine,
  PROVISIONING_SECRET_KINDS,
  PROVISIONING_STAGE_IDS,
  writeWindowsAccountSecrets,
} from "./provisioning.js";

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
      secretsDirectory: path.join(root, "secrets"),
      passwordLength: 24,
      generatedAt: new Date("2026-05-27T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, counter++),
    });

    expect(result.rootDirectory).toBe(path.join(root, "secrets", "analysis-vm"));
    expect(result.accounts).toEqual([
      expect.objectContaining({
        username: "CrucibleUser",
        principal: "standard",
        path: path.join(root, "secrets", "analysis-vm", "windows", "standard-user.json"),
        fileMode: "0600",
      }),
      expect.objectContaining({
        username: "CrucibleAdmin",
        principal: "admin",
        path: path.join(root, "secrets", "analysis-vm", "windows", "admin-user.json"),
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
  return mkdtemp(path.join(tmpdir(), "crucible-provisioning-"));
}
