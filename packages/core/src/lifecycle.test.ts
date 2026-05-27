import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCrucibleConfig } from "./config.js";
import {
  buildLifecyclePaths,
  VmLifecycleManager,
  type VmProcessController,
  type VmQmpClientFactory,
  type VmQmpSession,
  type VmSpawnRequest,
} from "./lifecycle.js";
import type { ArtifactManifest } from "./manifest.js";
import { buildQemuCommandPlan } from "./qemu.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("VmLifecycleManager", () => {
  it("starts QEMU, writes pid files, logs, and state manifests", async () => {
    const harness = await createLifecycleHarness();

    const result = await harness.manager.start();

    expect(result.pid).toBe(4242);
    expect(result.status).toMatchObject({
      status: "running",
      pid: 4242,
      processAlive: true,
    });
    expect(harness.spawnRequests).toEqual([
      expect.objectContaining({
        executable: "qemu-system-x86_64",
        stdoutLog: harness.paths.stdoutLog,
        stderrLog: harness.paths.stderrLog,
      }),
    ]);
    expect(await readFile(harness.paths.pidFile, "utf8")).toBe("4242\n");
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      version: 1,
      vmName: "life-test",
      state: "running",
      pid: 4242,
      paths: harness.paths,
    });
    const artifactManifest = await readJson<ArtifactManifest>(harness.paths.artifactManifest);
    expect(artifactManifest.version).toBe(1);
    expect(artifactManifest.vmName).toBe("life-test");
    expect(artifactManifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "disk", path: harness.plan.disk.path }),
        expect.objectContaining({ kind: "pidFile", path: harness.paths.pidFile }),
        expect.objectContaining({ kind: "socket", path: harness.paths.qmpSocket }),
        expect.objectContaining({ kind: "log", path: harness.paths.stdoutLog }),
      ]),
    );
  });

  it("rejects start when an owned VM process is already alive", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();

    await expect(harness.manager.start()).rejects.toMatchObject({
      code: "STATE_INVALID",
      message: "VM is already running",
    });
  });

  it("uses QMP quit for graceful stop and marks the VM stopped", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();
    harness.qmp.nextExecute = () => {
      harness.processes.delete(4242);
      return { returnValue: {} };
    };

    const result = await harness.manager.stop();

    expect(result).toMatchObject({
      mode: "stop",
      qmpCommandSent: true,
      killedAfterTimeout: false,
      status: { status: "stopped", processAlive: false },
    });
    expect(harness.qmp.commands.at(-1)).toBe("quit");
    expect(harness.signals).toEqual([]);
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      state: "stopped",
    });
  });

  it("uses QMP system_powerdown for poweroff", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();
    harness.qmp.nextExecute = () => {
      harness.processes.delete(4242);
      return { returnValue: {} };
    };

    const result = await harness.manager.poweroff();

    expect(result).toMatchObject({
      mode: "poweroff",
      qmpCommandSent: true,
      killedAfterTimeout: false,
      status: { status: "poweredOff", processAlive: false },
    });
    expect(harness.qmp.commands.at(-1)).toBe("system_powerdown");
  });

  it("falls back to SIGTERM then SIGKILL when QMP is unavailable and timeout expires", async () => {
    const harness = await createLifecycleHarness({ qmpConnectError: new Error("no qmp") });
    await harness.manager.start();

    const result = await harness.manager.stop();

    expect(result).toMatchObject({
      mode: "stop",
      qmpCommandSent: false,
      signalSent: "SIGKILL",
      killedAfterTimeout: true,
      status: { status: "stopped", processAlive: false },
    });
    expect(harness.signals).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("reports QMP status when the VM is alive", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();
    harness.qmp.nextExecute = () => ({ returnValue: { status: "running" } });

    const status = await harness.manager.status();

    expect(status).toMatchObject({
      status: "running",
      processAlive: true,
      qmpAvailable: true,
      qmpStatus: "running",
    });
    expect(harness.qmp.commands).toContain("query-status");
  });

  it("sweeps stale pid and socket resources only when the process is gone", async () => {
    const harness = await createLifecycleHarness();
    await mkdirFor(harness.paths.pidFile);
    await writeFile(harness.paths.pidFile, "9999\n", "utf8");
    await writeFile(harness.paths.qmpSocket, "stale qmp", "utf8");
    await writeFile(harness.paths.qgaSocket, "stale qga", "utf8");

    const cleanup = await harness.manager.cleanupStaleResources();

    expect(cleanup.removedPaths).toEqual([
      harness.paths.pidFile,
      harness.paths.qmpSocket,
      harness.paths.qgaSocket,
    ]);
    await expect(readFile(harness.paths.pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(harness.paths.qmpSocket, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(cleanup.status.status).toBe("stopped");
  });
});

type HarnessOptions = {
  readonly qmpConnectError?: Error;
};

async function createLifecycleHarness(options: HarnessOptions = {}) {
  const root = await createTempDir();
  const config = parseCrucibleConfig({
    vm: { name: "life-test" },
    artifacts: {
      directory: path.join(root, "artifacts"),
      manifestPath: path.join(root, "artifacts", "manifest.json"),
      logsDirectory: path.join(root, "artifacts", "logs"),
      snapshotsDirectory: path.join(root, "snapshots"),
      secretsDirectory: path.join(root, "secrets"),
    },
    qmp: { socketPath: path.join(root, "artifacts", "qmp.sock"), timeoutMs: 100 },
    qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
  });
  const plan = buildQemuCommandPlan({ config });
  const paths = buildLifecyclePaths(config);
  const processes = new Set<number>();
  const spawnRequests: VmSpawnRequest[] = [];
  const signals: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }> = [];
  const qmp = new FakeQmpSession(options.qmpConnectError);
  const qmpClientFactory: VmQmpClientFactory = () => qmp;
  const processController: VmProcessController = {
    isAlive: (pid) => processes.has(pid),
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGKILL") {
        processes.delete(pid);
      }
    },
    waitForExit: (pid) => Promise.resolve(!processes.has(pid)),
  };
  const manager = new VmLifecycleManager({
    config,
    plan,
    spawner: {
      spawn(request) {
        spawnRequests.push(request);
        processes.add(4242);
        return Promise.resolve({ pid: 4242 });
      },
    },
    processController,
    qmpClientFactory,
    stopTimeoutMs: 1,
    killTimeoutMs: 1,
    pollIntervalMs: 1,
    now: () => new Date("2026-05-27T00:00:00.000Z"),
  });

  return { config, manager, paths, plan, processes, qmp, signals, spawnRequests };
}

class FakeQmpSession implements VmQmpSession {
  readonly commands: string[] = [];
  nextExecute: ((command: string) => { readonly returnValue: unknown }) | undefined;

  constructor(readonly connectError?: Error) {}

  connect(): Promise<unknown> {
    if (this.connectError !== undefined) {
      return Promise.reject(this.connectError);
    }
    return Promise.resolve({});
  }

  execute<T = unknown>(command: string): Promise<{ readonly returnValue: T }> {
    this.commands.push(command);
    return Promise.resolve(
      (this.nextExecute?.(command) ?? { returnValue: {} }) as { readonly returnValue: T },
    );
  }

  close(): void {
    return undefined;
  }
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

async function mkdirFor(filePath: string): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(filePath), { recursive: true }),
  );
}

async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}
