import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildLifecyclePaths,
  CRUCIBLE_VERSION,
  parseCrucibleConfig,
  type GuestAgentHealth,
  type VmStatus,
} from "@crucible/core";
import { afterEach, describe, expect, it } from "vitest";

import { runCrucibleCli } from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function e2eLifecycle(config: ReturnType<typeof parseCrucibleConfig>) {
  const paths = buildLifecyclePaths(config);
  const status: VmStatus = {
    status: "running",
    processAlive: true,
    qmpAvailable: true,
    qmpStatus: "running",
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

function e2eSnapshotManager(config: ReturnType<typeof parseCrucibleConfig>) {
  const diskPath = path.join(config.artifacts.directory, "disks", `${config.vm.name}.qcow2`);
  const snapshot = (name: string) => ({
    kind: "snapshot" as const,
    name,
    path: diskPath,
    createdAt: "2026-06-02T00:00:00.000Z",
    baseDiskPath: diskPath,
    clean: name === "clean-base",
    qemuTag: name,
    mode: "online-qmp" as const,
  });
  return {
    create: (name: string) =>
      Promise.resolve({
        snapshot: snapshot(name),
        qmpCommands: ["snapshot-save"],
        qcow2Commands: [],
      }),
    list: () => Promise.resolve([snapshot("clean-base")]),
    restore: (name: string) =>
      Promise.resolve({
        snapshot: snapshot(name),
        restoredAt: "2026-06-02T00:00:00.000Z",
        qmpCommands: ["snapshot-load"],
        qcow2Commands: [],
      }),
  };
}

function e2eGuestHealth(): GuestAgentHealth {
  return {
    status: "ok",
    version: "e2e",
    hostName: "e2e-vm",
    startedAt: "2026-06-02T00:00:00.000Z",
    uptimeSeconds: 60,
    goVersion: "go1.e2e",
    windbgInstalled: true,
  };
}

describe("Crucible CLI E2E smoke", () => {
  it("walks a provision-to-utility workflow through the CLI dispatcher", async () => {
    const root = await createTempDir("crucible-cli-e2e-");
    const config = parseCrucibleConfig({
      vm: { name: "e2e-vm" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
      realism: {
        enabled: true,
        seed: "cli-e2e",
        installCommonSoftware: true,
        simulateUserHistory: true,
      },
    });
    const lifecycle = e2eLifecycle(config);
    const snapshotManager = e2eSnapshotManager(config);
    await mkdir(path.dirname(lifecycle.paths.stdoutLog), { recursive: true });
    await writeFile(lifecycle.paths.stdoutLog, "e2e stdout\n", "utf8");
    await writeFile(lifecycle.paths.stderrLog, "e2e stderr\n", "utf8");

    const provision = await runCrucibleCli(["provision"], {
      config,
      lifecycleManager: lifecycle,
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
      snapshotManager,
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(e2eGuestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from("guest-e2e").toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 5,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
      skipBootKeyNudge: true,
    });
    const status = await runCrucibleCli(["vm", "status"], { config, lifecycleManager: lifecycle });
    const logs = await runCrucibleCli(["vm", "logs"], { config, lifecycleManager: lifecycle });
    const view = await runCrucibleCli(["vm", "view", "--dry-run"], { config });
    const network = await runCrucibleCli(["network", "status"], { config });
    const snapshots = await runCrucibleCli(["snapshot", "list"], { config, snapshotManager });
    const restore = await runCrucibleCli(["snapshot", "restore", "clean-base"], {
      config,
      snapshotManager,
    });
    const guestExec = await runCrucibleCli(["guest", "exec", "whoami.exe"], {
      config,
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(e2eGuestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from("nt authority\\system\n").toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 5,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });
    const update = await runCrucibleCli(["update", "--dry-run"], {
      config,
      processRunner: {
        run(command) {
          return Promise.resolve({
            command,
            exitCode: 0,
            stdout: command.args.includes("view") ? `${CRUCIBLE_VERSION}\n` : `${root}\n`,
            stderr: "",
            durationMs: 1,
            timedOut: false,
            signal: null,
          });
        },
      },
    });

    expect(provision.exitCode).toBe(0);
    expect(provision.stdout).toContain("Provisioning status: complete");
    expect(status.stdout).toContain("status: running");
    expect(logs.stdout).toContain("e2e stdout");
    expect(view.stdout).toContain("change vnc 127.0.0.1:1");
    expect(network.stdout).toContain("Network status:");
    expect(snapshots.stdout).toContain("clean-base");
    expect(restore.stdout).toContain("Snapshot restored: clean-base");
    expect(guestExec.stdout).toContain("nt authority\\system");
    expect(update.stdout).toContain("current version: 1.1.0");
  });
});
