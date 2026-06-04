import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildLifecyclePaths,
  CRUCIBLE_VERSION,
  parseCrucibleConfig,
  type GuestAgentHealth,
  type ProcessCommand,
  type VmStatus,
} from "@crucible/core";
import { afterEach, describe, expect, it } from "vitest";

import { CLI_COMMANDS, runCrucibleCli } from "./index.js";

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

function e2eGuestClient(stdout = "guest-e2e") {
  return {
    health: () => Promise.resolve(e2eGuestHealth()),
    exec: () =>
      Promise.resolve({
        exitCode: 0,
        stdoutBase64: Buffer.from(stdout).toString("base64"),
        stderrBase64: "",
        timedOut: false,
        durationMs: 5,
        truncated: false,
      }),
    close: () => Promise.resolve(),
  };
}

function e2eProcessRunner(stdout = "e2e process\n") {
  return {
    run(command: ProcessCommand) {
      return Promise.resolve({
        command,
        exitCode: 0,
        stdout: command.args.includes("view") ? `${CRUCIBLE_VERSION}\n` : stdout,
        stderr: "",
        durationMs: 1,
        timedOut: false,
        signal: null,
      });
    },
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
      guestClientFactory: () => Promise.resolve(e2eGuestClient()),
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
      guestClientFactory: () => Promise.resolve(e2eGuestClient("nt authority\\system\n")),
    });
    const update = await runCrucibleCli(["update", "--dry-run"], {
      config,
      processRunner: e2eProcessRunner(`${root}\n`),
    });

    expect(provision.exitCode).toBe(0);
    expect(provision.stdout).toContain("Provisioning status: complete");
    expect(status.stdout).toContain("status: running");
    expect(logs.stdout).toContain("e2e stdout");
    expect(view.stdout).toContain("bridge command: socat");
    expect(network.stdout).toContain("Network status:");
    expect(snapshots.stdout).toContain("clean-base");
    expect(restore.stdout).toContain("Snapshot restored: clean-base");
    expect(guestExec.stdout).toContain("nt authority\\system");
    expect(update.stdout).toContain(`current version: ${CRUCIBLE_VERSION}`);
  });

  it("covers every registered CLI command with safe arguments", async () => {
    const root = await createTempDir("crucible-cli-surface-");
    const config = parseCrucibleConfig({
      vm: { name: "surface-vm" },
      media: {
        windowsIso: { path: path.join(root, "windows.iso") },
        virtioIso: { path: path.join(root, "virtio.iso") },
      },
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
    const lifecycle = e2eLifecycle(config);
    const snapshotManager = e2eSnapshotManager(config);
    await mkdir(path.dirname(lifecycle.paths.stdoutLog), { recursive: true });
    await writeFile(lifecycle.paths.stdoutLog, "surface stdout\n", "utf8");
    await writeFile(lifecycle.paths.stderrLog, "surface stderr\n", "utf8");

    const baseRuntime = {
      config,
      lifecycleManager: lifecycle,
      snapshotManager,
      guestClientFactory: () => Promise.resolve(e2eGuestClient("surface guest\n")),
      processRunner: e2eProcessRunner(`${root}\n`),
      skipBootKeyNudge: true,
      qmpClientFactory: () => ({
        connect: () => Promise.resolve(undefined),
        execute: () => Promise.resolve({}),
        close: () => undefined,
      }),
    };
    const provisionRuntime = {
      ...baseRuntime,
      provisioningExecutor: {
        runStage(stage: {
          readonly id: string;
          readonly title: string;
          readonly script?: { readonly scriptPath: string };
        }) {
          return Promise.resolve({
            id: stage.id,
            title: stage.title,
            status: "succeeded" as const,
            detail: stage.script?.scriptPath ?? "readiness contract",
          });
        },
      },
    };
    const cases: Record<
      string,
      {
        readonly args: readonly string[];
        readonly runtime?: typeof baseRuntime | typeof provisionRuntime;
        readonly expectExitCode?: number | readonly number[];
        readonly expectStdout?: RegExp;
      }
    > = {
      "config:init": {
        args: ["config", "init", "--output", path.join(root, "config.json")],
        expectStdout: /Wrote .*config\.json/,
      },
      doctor: {
        args: ["doctor"],
        expectExitCode: [0, 1],
        expectStdout: /Status: healthy|Status: degraded|Status: missing/,
      },
      setup: {
        args: ["setup", "host", "--print"],
        expectStdout: /Host prerequisites|Install command:/,
      },
      version: { args: ["version"], expectStdout: /\d+\.\d+\.\d+/ },
      update: { args: ["update", "--dry-run"], expectStdout: /Crucible update plan:/ },
      provision: {
        args: ["provision"],
        runtime: provisionRuntime,
        expectStdout: /Provisioning status:/,
      },
      mcp: { args: ["mcp"], expectStdout: /Bootstrap tools:/ },
      package: { args: ["package"], expectStdout: /Package command:/ },
      "media:plan": { args: ["media", "plan", "--manual"], expectStdout: /Media profile:/ },
      "media:fetch-tools": {
        args: ["media", "fetch-tools", "--help"],
        expectStdout: /Download optional tool archives/,
      },
      "vm:create": { args: ["vm", "create", "--dry-run"], expectStdout: /VM create dry run:/ },
      "vm:start": { args: ["vm", "start", "--dry-run"], expectStdout: /VM start dry run:/ },
      "vm:stop": { args: ["vm", "stop"], expectStdout: /VM stop requested/ },
      "vm:status": { args: ["vm", "status"], expectStdout: /status: running/ },
      "vm:credentials": {
        args: ["vm", "credentials"],
        expectExitCode: 1,
        expectStdout: undefined,
      },
      "vm:paste": {
        args: ["vm", "paste", "--text", "P@ssw0rd!"],
        expectStdout: /pasted 9 character\(s\)/,
      },
      "vm:view": {
        args: ["vm", "view", "--dry-run"],
        expectStdout: /bridge command: socat/,
      },
      "vm:logs": { args: ["vm", "logs"], expectStdout: /surface stdout/ },
      "snapshot:create": {
        args: ["snapshot", "create", "surface"],
        expectStdout: /Snapshot created:/,
      },
      "snapshot:list": { args: ["snapshot", "list"], expectStdout: /clean-base/ },
      "snapshot:restore": {
        args: ["snapshot", "restore", "clean-base"],
        expectStdout: /Snapshot restored:/,
      },
      "net:plan": {
        args: ["network", "plan", "--mode", "isolated"],
        expectStdout: /Network mode:/,
      },
      "net:status": { args: ["network", "status"], expectStdout: /Network status:/ },
      "net:set": { args: ["network", "set", "nat"], expectStdout: /Network mode change:/ },
      "net:teardown": {
        args: ["network", "teardown", "--dry-run"],
        expectStdout: /Network teardown/,
      },
      "guest:health": { args: ["guest", "health", "--help"], expectStdout: /Check guest-agent/ },
      "guest:exec": { args: ["guest", "exec", "whoami.exe"], expectStdout: /surface guest/ },
      "debug:smoke": {
        args: ["debug", "smoke", "--exe", "C:\\Windows\\System32\\notepad.exe"],
        expectStdout: /debug session:/,
      },
      "scenario:malware-dry-run": {
        args: ["scenario", "malware-dry-run"],
        expectStdout: /Scenario: malware-dry-run/,
      },
    };

    expect(Object.keys(cases).sort()).toEqual(
      CLI_COMMANDS.map((command) => command.canonical).sort(),
    );
    for (const [canonical, testCase] of Object.entries(cases)) {
      const result = await runCrucibleCli(testCase.args, testCase.runtime ?? baseRuntime);
      const expectedExitCodes = Array.isArray(testCase.expectExitCode)
        ? testCase.expectExitCode
        : [testCase.expectExitCode ?? 0];
      expect(expectedExitCodes, `${canonical}\n${result.stdout}\n${result.stderr}`).toContain(
        result.exitCode,
      );
      if (testCase.expectStdout !== undefined) {
        expect(result.stdout, canonical).toMatch(testCase.expectStdout);
      }
    }
  });
});
