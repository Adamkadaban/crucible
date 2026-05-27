import { describe, expect, it } from "vitest";

import {
  buildProvisioningPlan,
  buildProvisioningSecretStorageContract,
  canAdvanceProvisioningStage,
  createInitialProvisioningStateMachine,
  PROVISIONING_SECRET_KINDS,
  PROVISIONING_STAGE_IDS,
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
      "-ControlAddress",
      "192.0.2.2",
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
});
