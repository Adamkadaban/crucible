import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLifecyclePaths,
  defaultCrucibleConfig,
  parseCrucibleConfig,
  type VmStatus,
} from "@crucible/core";

import { runCrucibleCli } from "./index.js";

const defaultRuntime = { config: defaultCrucibleConfig };

describe("crucible CLI bootstrap", () => {
  it("prints help", async () => {
    const result = await runCrucibleCli(["--help"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("crucible provision");
    expect(result.stdout).toContain("crucible mcp");
  });

  it("prints media plan without manual links by default", async () => {
    const result = await runCrucibleCli(["media:plan"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Media profile: windows11-enterprise-eval");
    expect(result.stdout).toContain("media/cache/Windows11EnterpriseEvaluation.iso");
    expect(result.stdout).toContain("media/cache/virtio-win-stable.iso");
    expect(result.stdout).toContain("Windows 11 Enterprise Evaluation");
    expect(result.stdout).toContain("virtio-win");
    expect(result.stdout).toContain("pass --manual");
    expect(result.stdout).not.toContain("Windows Server 2025 Evaluation page");
  });

  it("prints profile-specific manual-download instructions with --manual", async () => {
    const result = await runCrucibleCli(["media:plan", "--manual"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Windows 11 Enterprise Evaluation page");
    expect(result.stdout).toContain("stable virtio-win ISO");
    expect(result.stdout).not.toContain("Windows Server 2025 Evaluation page");
    expect(result.stdout).not.toContain("latest virtio-win ISO");
  });

  it("prints alternate Windows Server media plan", async () => {
    const result = await runCrucibleCli(
      ["media:plan", "--profile", "windows-server-2025-eval"],
      defaultRuntime,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Media profile: windows-server-2025-eval");
    expect(result.stdout).toContain("media/cache/WindowsServer2025Evaluation.iso");
    expect(result.stdout).not.toContain("Windows 11 Enterprise Evaluation page");
  });

  it("prints isolated network dry-run plan without guest egress", async () => {
    const result = await runCrucibleCli(["net:plan", "--mode", "isolated"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode: isolated");
    expect(result.stdout).toContain("QEMU backend: user");
    expect(result.stdout).toContain("restrict=on");
    expect(result.stdout).toContain("hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443");
    expect(result.stdout).toContain("crucible-test-win-net0-deny-guest-egress");
    expect(result.stdout).toContain("drop");
    expect(result.stdout).toContain("Apply commands are hidden by default");
  });

  it("prints apply model only when explicitly requested", async () => {
    const result = await runCrucibleCli(
      ["net:plan", "--mode", "capture", "--backend", "iptables", "--apply"],
      {
        config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode: capture");
    expect(result.stdout).toContain("Firewall backend: iptables");
    expect(result.stdout).toContain("Firewall apply commands (not executed by net:plan):");
    expect(result.stdout).toContain("Firewall teardown commands (project-owned rules only):");
    expect(result.stdout).toContain("CRUCIBLE-CRUCIBLE-TEST-WIN-NET0");
    expect(result.stdout).not.toContain(" -F ");
    expect(result.stdout).not.toContain("iptables -X FORWARD");
  });

  it("prints network teardown dry-run by default", async () => {
    const result = await runCrucibleCli(["net:teardown", "--mode", "capture"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network teardown dry-run:");
    expect(result.stdout).toContain("Owner: crucible/test-win/crucible-test-win-net0");
    expect(result.stdout).toContain("Missing resources: ignored");
    expect(result.stdout).toContain("Phase 2 print-only: no privileged host changes are executed.");
    expect(result.stdout).toContain("Dry-run commands:");
    expect(result.stdout).toContain("interface crucible-test-win-net0-tap");
    expect(result.stdout).toContain("printf");
    expect(result.stdout).not.toContain("iptables -F");
  });

  it("prints network teardown apply model only when explicitly requested", async () => {
    const result = await runCrucibleCli(
      ["net:teardown", "--mode", "capture", "--backend", "iptables", "--apply"],
      {
        config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network teardown apply:");
    expect(result.stdout).toContain("Phase 2 print-only: no privileged host changes are executed.");
    expect(result.stdout).toContain("Apply commands:");
    expect(result.stdout).toContain("iptables -D CRUCIBLE-CRUCIBLE-TEST-WIN-NET0");
    expect(result.stdout).toContain("ip link delete dev crucible-test-win-net0-tap");
    expect(result.stdout).not.toContain("iptables -X FORWARD");
  });

  it("rejects unknown network plan options", async () => {
    const result = await runCrucibleCli(["net:plan", "--backend", "pf"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown firewall backend: pf");
  });

  it("rejects unknown network teardown options", async () => {
    const result = await runCrucibleCli(["net:teardown", "--backend", "pf"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown firewall backend: pf");
  });

  it("rejects conflicting network teardown operation flags", async () => {
    const result = await runCrucibleCli(["net:teardown", "--dry-run", "--apply"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("net:teardown accepts only one of --dry-run or --apply");
  });

  it("prints alternate Windows Server manual-download instructions", async () => {
    const result = await runCrucibleCli(
      ["media:plan", "--manual", "--profile", "windows-server-2025-eval"],
      defaultRuntime,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Windows Server 2025 Evaluation page");
    expect(result.stdout).toContain("stable virtio-win ISO");
    expect(result.stdout).not.toContain("Windows 11 Enterprise Evaluation page");
    expect(result.stdout).not.toContain("latest virtio-win ISO");
  });

  it("rejects unknown media profile", async () => {
    const result = await runCrucibleCli(["media:plan", "--profile", "windows-10"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown media profile: windows-10");
  });

  it("runs provision through fake lifecycle, stage, snapshot, and health contracts", async () => {
    const config = parseCrucibleConfig({
      vm: { name: "test-win" },
      analysisPolicy: {
        profile: {
          hostname: "DESKTOP-7F3K9Q2",
          username: "analyst",
          commonAnalysisLabCamouflage: true,
        },
      },
    });
    const result = await runCrucibleCli(["provision"], {
      config,
      lifecycleManager: fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true }),
      provisioningExecutor: {
        runStage(stage) {
          return Promise.resolve({
            id: stage.id,
            title: stage.title,
            status: "succeeded",
            detail: stage.script?.scriptPath ?? "readiness contract",
          });
        },
      },
      snapshotManager: fakeSnapshotManager(config),
      skipBootKeyNudge: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Provisioning status: complete");
    expect(result.stdout).toContain("policy-configured: succeeded");
    expect(result.stdout).toContain("guest/provision/configure-policy.ps1");
    expect(result.stdout).toContain("Snapshot created: clean-base");
    expect(result.stdout).toContain("Guest health: degraded");
    expect(result.stdout).toContain("debugger-health: unknown");
  });

  it("rejects unknown provision options", async () => {
    const result = await runCrucibleCli(["provision", "--apply"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown provision option: --apply");
  });

  it("prints snapshot create and restore results", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const snapshotManager = fakeSnapshotManager(config);

    const create = await runCrucibleCli(["snapshot:create", "clean-base"], {
      config,
      snapshotManager,
    });
    const restore = await runCrucibleCli(["snapshot:restore", "clean-base"], {
      config,
      snapshotManager,
    });

    expect(create.exitCode).toBe(0);
    expect(create.stdout).toContain("Snapshot created: clean-base");
    expect(create.stdout).toContain("qmp commands: snapshot-save");
    expect(restore.exitCode).toBe(0);
    expect(restore.stdout).toContain("Snapshot restored: clean-base");
    expect(restore.stdout).toContain("qmp commands: snapshot-load");
  });

  it("reports guest health from lifecycle and provisioning contracts", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const result = await runCrucibleCli(["guest:health"], {
      config,
      lifecycleManager: fakeLifecycleManager(config, { processAlive: false, qmpAvailable: false }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Guest health: unavailable");
    expect(result.stdout).toContain("debugger-health: fail");
    expect(result.stdout).toContain("QMP is unavailable");
  });

  it("reports live guest health when a guest client is configured", async () => {
    const result = await runCrucibleCli(["guest:health"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () =>
            Promise.resolve({
              status: "ok",
              version: "test-version",
              hostName: "test-win",
              startedAt: "2026-05-29T00:00:00.000Z",
              uptimeSeconds: 42,
              goVersion: "go1.test",
              windbgInstalled: true,
              cdbPath: "C:\\Debuggers\\cdb.exe",
              windbgPath: "C:\\Debuggers\\windbg.exe",
            }),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from(
                JSON.stringify({
                  cdbPath: "C:\\Debuggers\\cdb.exe",
                  windbgPath: "C:\\Debuggers\\windbg.exe",
                  symbolPath: "srv*C:\\symbols*https://msdl.microsoft.com/download/symbols",
                  crucibleAdminPresent: true,
                  crucibleUserPresent: true,
                  qemuAgentStatus: "Running",
                  crucibleAgentStatus: "Running",
                  defenderRealTimeProtectionEnabled: false,
                  codeIntegrityStateRecorded: true,
                  codeIntegrityEnforcementDisabled: true,
                  hypervisorEnforcedCodeIntegrityDisabled: true,
                  codeIntegrityBootOptions: [],
                  testSigningEnabled: false,
                  healthy: true,
                }),
              ).toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 10,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Guest health: healthy");
    expect(result.stdout).toContain("WinDbg installed: yes");
    expect(result.stdout).toContain("CDB path: C:\\Debuggers\\cdb.exe");
    expect(result.stdout).toContain("Defender real-time protection: no");
    expect(result.stdout).toContain("code-integrity state recorded: yes");
    expect(result.stdout).toContain("code-integrity enforcement disabled: yes");
    expect(result.stdout).toContain("test signing enabled: no");
  });

  it("prints vm:create dry-run QEMU planning output", async () => {
    const result = await runCrucibleCli(["vm:create", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VM create dry run:");
    expect(result.stdout).toContain("qemu-img create -f qcow2");
    expect(result.stdout).toContain("qemu-system-x86_64");
    expect(result.stdout).toContain("artifacts/disks/test-win.qcow2");
    expect(result.stdout).toContain("network mode: isolated (user)");
    expect(result.stdout).toContain("guest control: 127.0.0.1:8443 -> 192.0.2.2:8443");
    expect(result.stdout).toContain("qmp socket: artifacts/qmp.sock");
  });

  it("prints vm:start dry-run QEMU planning output", async () => {
    const result = await runCrucibleCli(["vm:start", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VM start dry run:");
    expect(result.stdout).not.toContain("qemu-img create -f qcow2");
    expect(result.stdout).toContain("type=q35,accel=kvm");
    expect(result.stdout).toContain(
      "user,id=crucible-test-win-net0,restrict=on,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
    );
    expect(result.stdout).toContain("qga socket: artifacts/qga.sock");
  });

  it("prints explicit NAT QEMU networking in vm:start dry-run output", async () => {
    const result = await runCrucibleCli(["vm:start", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" }, network: { mode: "nat" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("network mode: nat (user)");
    expect(result.stdout).toContain(
      "user,id=crucible-test-win-net0,restrict=off,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
    );
  });

  it("prints explicit capture QEMU networking in vm:start dry-run output", async () => {
    const result = await runCrucibleCli(["vm:start", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" }, network: { mode: "capture" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("network mode: capture (tap)");
    expect(result.stdout).toContain(
      "tap,id=crucible-test-win-net0,ifname=crucible-test-win-net0-tap,script=no,downscript=no",
    );
  });

  it("uses default config instead of cwd config when tests do not inject runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const result = await runCrucibleCli(["vm:start", "--dry-run"], {
      configPath: path.join(root, "missing.config.json"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("artifacts/disks/crucible-win11.qcow2");
  });

  it("reports the first invalid vm:stop option before extra arguments", async () => {
    const result = await runCrucibleCli(["vm:stop", "--unknown", "--kill"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown vm:stop option: --unknown");
  });

  it("rejects extra vm:stop arguments after a valid option", async () => {
    const result = await runCrucibleCli(["vm:stop", "--kill", "--extra"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown vm:stop option: --extra");
  });

  it("prints stopped VM status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const result = await runCrucibleCli(["vm:status"], {
      config: parseCrucibleConfig({
        vm: { name: "test-win" },
        artifacts: {
          directory: path.join(root, "artifacts"),
          manifestPath: path.join(root, "artifacts", "manifest.json"),
          logsDirectory: path.join(root, "artifacts", "logs"),
          snapshotsDirectory: path.join(root, "snapshots"),
          secretsDirectory: path.join(root, "secrets"),
        },
        qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
        qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status: stopped");
    expect(result.stdout).toContain("pid: none");
  });

  it("prints missing VM logs before the VM has started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const config = parseCrucibleConfig({
      vm: { name: "test-win" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });

    const result = await runCrucibleCli(["vm:logs"], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stdout log:");
    expect(result.stdout).toContain("(missing)");
  });

  it("prints existing VM logs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const logsDirectory = path.join(root, "artifacts", "logs");
    const config = parseCrucibleConfig({
      vm: { name: "test-win" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory,
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });
    await mkdir(logsDirectory, { recursive: true });
    await writeFile(path.join(logsDirectory, "test-win.stdout.log"), "out\n", "utf8");
    await writeFile(path.join(logsDirectory, "test-win.stderr.log"), "err\n", "utf8");

    const result = await runCrucibleCli(["vm:logs"], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("out");
    expect(result.stdout).toContain("err");
  });

  it("prints snapshot list from the artifact manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const config = parseCrucibleConfig({
      vm: { name: "test-win" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await writeFile(
      config.artifacts.manifestPath,
      JSON.stringify({
        version: 1,
        vmName: "test-win",
        artifacts: [
          {
            kind: "snapshot",
            name: "clean-base",
            path: path.join(root, "artifacts", "disks", "test-win.qcow2"),
            createdAt: "2026-05-27T00:00:00.000Z",
            baseDiskPath: path.join(root, "artifacts", "disks", "test-win.qcow2"),
            clean: true,
            mode: "offline-qcow2",
          },
        ],
      }),
      "utf8",
    );

    const result = await runCrucibleCli(["snapshot:list"], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Snapshots:");
    expect(result.stdout).toContain("clean-base: clean, offline-qcow2");
  });

  it("defaults snapshot commands to clean-base", async () => {
    const result = await runCrucibleCli(["snapshot:restore", "--flag"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("snapshot:restore accepts at most one snapshot name");
  });

  it("reports unsafe snapshot names as argument validation errors", async () => {
    const result = await runCrucibleCli(["snapshot:create", "../escape"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Snapshot names must be 1-64 characters");
  });
});

function fakeLifecycleManager(
  config: ReturnType<typeof parseCrucibleConfig>,
  options: { readonly processAlive: boolean; readonly qmpAvailable: boolean },
) {
  const paths = buildLifecyclePaths(config);
  const status: VmStatus = {
    status: options.processAlive ? "running" : "stopped",
    processAlive: options.processAlive,
    qmpAvailable: options.qmpAvailable,
    qmpStatus: options.qmpAvailable ? "running" : undefined,
    paths,
    warnings: [],
  };

  return {
    paths,
    start: () => Promise.resolve({ pid: 1234, status }),
    stop: () =>
      Promise.resolve({
        status,
        mode: "stop" as const,
        qmpCommandSent: true,
        killedAfterTimeout: false,
      }),
    poweroff: () =>
      Promise.resolve({
        status,
        mode: "poweroff" as const,
        qmpCommandSent: true,
        killedAfterTimeout: false,
      }),
    kill: () =>
      Promise.resolve({
        status,
        mode: "stop" as const,
        qmpCommandSent: false,
        killedAfterTimeout: true,
      }),
    status: () => Promise.resolve(status),
  };
}

function fakeSnapshotManager(config: ReturnType<typeof parseCrucibleConfig>) {
  return {
    create: (snapshotName: string) =>
      Promise.resolve(fakeSnapshotCreateResult(config, snapshotName)),
    list: () => Promise.resolve([]),
    restore: (snapshotName: string) =>
      Promise.resolve({
        ...fakeSnapshotCreateResult(config, snapshotName),
        restoredAt: "2026-05-27T00:00:00.000Z",
        qmpCommands: ["snapshot-load"],
      }),
  };
}

function fakeSnapshotCreateResult(
  config: ReturnType<typeof parseCrucibleConfig>,
  snapshotName: string,
) {
  const diskPath = path.join(config.artifacts.directory, "disks", `${config.vm.name}.qcow2`);

  return {
    snapshot: {
      kind: "snapshot" as const,
      name: snapshotName,
      path: diskPath,
      createdAt: "2026-05-27T00:00:00.000Z",
      baseDiskPath: diskPath,
      clean: snapshotName === "clean-base",
      qemuTag: snapshotName,
      mode: "online-qmp" as const,
    },
    qmpCommands: ["snapshot-save"],
    qcow2Commands: [],
  };
}
