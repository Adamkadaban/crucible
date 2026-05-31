import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCrucibleConfig } from "./config.js";
import type { VmQmpClientFactory, VmQmpSession } from "./lifecycle.js";
import type { ArtifactManifest, SnapshotRecord } from "./manifest.js";
import type { ProcessCommand, ProcessRunner } from "./process.js";
import { buildQemuCommandPlan } from "./qemu.js";
import { CLEAN_BASE_SNAPSHOT_NAME, normalizeSnapshotName, SnapshotManager } from "./snapshot.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("SnapshotManager", () => {
  it("creates clean-base snapshots through QMP and records manifest metadata", async () => {
    const harness = await createSnapshotHarness();

    const result = await harness.manager.create();

    expect(result.qmpCommands).toEqual(["stop", "snapshot-save", "cont"]);
    expect(harness.qmp.calls.map((call) => call.command)).toEqual([
      "stop",
      "snapshot-save",
      "cont",
    ]);
    expect(harness.qmp.calls[1]?.args).toMatchObject({
      tag: CLEAN_BASE_SNAPSHOT_NAME,
      vmstate: "crucible-disk0",
      devices: ["crucible-disk0"],
    });
    expect((harness.qmp.calls[1]?.args as { "job-id"?: string })?.["job-id"]).toMatch(
      /^crucible-snapshot-save-\d+-[0-9a-f]{8}$/,
    );
    expect(result.qcow2Commands).toEqual([]);
    expect(result.snapshot).toMatchObject({
      kind: "snapshot",
      name: "clean-base",
      clean: true,
      mode: "online-qmp",
      baseDiskPath: harness.plan.disk.path,
      qemuTag: "clean-base",
    });
    const manifest = await readJson<ArtifactManifest>(harness.config.artifacts.manifestPath);
    expect(manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "snapshot",
          name: "clean-base",
          clean: true,
          mode: "online-qmp",
        }),
      ]),
    );
  });

  it("falls back to offline qcow2 snapshot creation when QMP is unavailable", async () => {
    const harness = await createSnapshotHarness({ qmpConnectError: new Error("no qmp") });

    const result = await harness.manager.create("baseline-1");

    expect(result.qmpCommands).toEqual([]);
    expect(result.qcow2Commands).toEqual([
      expect.objectContaining({ args: ["snapshot", "-c", "baseline-1", harness.plan.disk.path] }),
    ]);
    expect(harness.processCommands).toEqual(result.qcow2Commands);
    expect(result.snapshot).toMatchObject({
      name: "baseline-1",
      clean: false,
      mode: "offline-qcow2",
    });
  });

  it("lists snapshot metadata from the artifact manifest", async () => {
    const harness = await createSnapshotHarness({ qmpConnectError: new Error("no qmp") });
    await harness.manager.create("z-last");
    await harness.manager.create("clean-base");

    const snapshots = await harness.manager.list();

    expect(snapshots.map((snapshot) => snapshot.name)).toEqual(["clean-base", "z-last"]);
  });

  it("refuses to overwrite an existing clean-base snapshot", async () => {
    const harness = await createSnapshotHarness();
    await harness.manager.create("clean-base");

    await expect(harness.manager.create("clean-base")).rejects.toThrow(
      /clean-base snapshot already exists/,
    );
  });

  it("restores online snapshots with QMP stop/load/cont semantics", async () => {
    const harness = await createSnapshotHarness();
    await harness.manager.create("clean-base");
    harness.qmp.calls.length = 0;

    const result = await harness.manager.restore("clean-base");

    expect(result.qmpCommands).toEqual(["stop", "snapshot-load", "cont"]);
    expect(harness.qmp.calls.map((call) => call.command)).toEqual([
      "stop",
      "snapshot-load",
      "cont",
    ]);
    expect(harness.qmp.calls[1]?.args).toMatchObject({
      tag: "clean-base",
      vmstate: "crucible-disk0",
      devices: ["crucible-disk0"],
    });
    expect((harness.qmp.calls[1]?.args as { "job-id"?: string })?.["job-id"]).toMatch(
      /^crucible-snapshot-load-\d+-[0-9a-f]{8}$/,
    );
    expect(result.restoredAt).toBe("2026-05-27T00:00:00.000Z");
    const manifest = await readJson<ArtifactManifest>(harness.config.artifacts.manifestPath);
    expect(manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "clean-base", restoredAt: "2026-05-27T00:00:00.000Z" }),
      ]),
    );
  });

  it("restores offline qcow2 snapshots with qemu-img apply semantics", async () => {
    const harness = await createSnapshotHarness({ qmpConnectError: new Error("no qmp") });
    await harness.manager.create("clean-base");
    harness.processCommands.length = 0;

    const result = await harness.manager.restore("clean-base");

    expect(result.qmpCommands).toEqual([]);
    expect(result.qcow2Commands).toEqual([
      expect.objectContaining({ args: ["snapshot", "-a", "clean-base", harness.plan.disk.path] }),
    ]);
    expect(harness.processCommands).toEqual(result.qcow2Commands);
  });

  it("restores offline-recorded snapshots through QMP when the VM is running", async () => {
    const harness = await createSnapshotHarness({ qmpConnectError: new Error("no qmp") });
    await harness.manager.create("clean-base");
    harness.qmp.connectError = undefined;
    harness.qmp.calls.length = 0;
    harness.processCommands.length = 0;

    const result = await harness.manager.restore("clean-base");

    expect(result.qmpCommands).toEqual(["stop", "snapshot-load", "cont"]);
    expect(result.qcow2Commands).toEqual([]);
    expect(harness.processCommands).toEqual([]);
  });

  it("resumes the VM when QMP restore fails after stop", async () => {
    const harness = await createSnapshotHarness({ qmpFailureCommand: "snapshot-load" });
    await harness.manager.create("clean-base");
    harness.qmp.calls.length = 0;

    await expect(harness.manager.restore("clean-base")).rejects.toThrow("snapshot-load failed");

    expect(harness.qmp.calls.map((call) => call.command)).toEqual([
      "stop",
      "snapshot-load",
      "cont",
    ]);
  });

  it("rejects restore when manifest snapshot disk does not match the current VM disk", async () => {
    const harness = await createSnapshotHarness({ qmpConnectError: new Error("no qmp") });
    await writeManifest(harness.config.artifacts.manifestPath, {
      version: 1,
      vmName: "snapshot-test",
      artifacts: [
        snapshotRecord({
          kind: "snapshot",
          name: "clean-base",
          path: "/other/disk.qcow2",
          createdAt: "2026-05-27T00:00:00.000Z",
          baseDiskPath: "/other/disk.qcow2",
          clean: true,
          mode: "offline-qcow2",
        }),
      ],
    });

    await expect(harness.manager.restore("clean-base")).rejects.toMatchObject({
      code: "STATE_INVALID",
      message: "Snapshot base disk does not match current VM disk",
    });
  });

  it("ignores malformed snapshot entries from the artifact manifest", async () => {
    const harness = await createSnapshotHarness();
    await writeManifest(harness.config.artifacts.manifestPath, {
      version: 1,
      vmName: "snapshot-test",
      artifacts: [{ kind: "snapshot", name: "bad", baseDiskPath: harness.plan.disk.path } as never],
    });

    await expect(harness.manager.list()).resolves.toEqual([]);
  });

  it("rejects unknown and unsafe snapshot names", async () => {
    const harness = await createSnapshotHarness();

    expect(() => normalizeSnapshotName("../escape")).toThrow("Snapshot names must be");
    await expect(harness.manager.restore("missing")).rejects.toMatchObject({
      code: "STATE_INVALID",
      message: "Snapshot not found: missing",
    });
  });

  it("surfaces qemu-img failures as structured process errors", async () => {
    const harness = await createSnapshotHarness({
      qmpConnectError: new Error("no qmp"),
      processExitCode: 1,
    });

    await expect(harness.manager.create("clean-base")).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      message: "qemu-img snapshot command failed",
    });
  });

  it("resumes the VM when QMP create fails after stop", async () => {
    const harness = await createSnapshotHarness({ qmpFailureCommand: "snapshot-save" });

    await expect(harness.manager.create()).rejects.toThrow("snapshot-save failed");

    expect(harness.qmp.calls.map((call) => call.command)).toEqual([
      "stop",
      "snapshot-save",
      "cont",
    ]);
  });

  it("allows non-clean-base snapshots with the same name to be recreated", async () => {
    const harness = await createSnapshotHarness();

    await harness.manager.create("my-snapshot");
    const result = await harness.manager.create("my-snapshot");

    expect(result.snapshot).toMatchObject({ name: "my-snapshot", clean: false });
  });

  it("normalizeSnapshotName accepts valid names", () => {
    expect(normalizeSnapshotName("a")).toBe("a");
    expect(normalizeSnapshotName("a.b")).toBe("a.b");
    expect(normalizeSnapshotName("a-b")).toBe("a-b");
    expect(normalizeSnapshotName("a_b")).toBe("a_b");
    expect(normalizeSnapshotName("0abc")).toBe("0abc");
    expect(normalizeSnapshotName("A".repeat(64))).toBe("A".repeat(64));
  });

  it("falls back to empty manifest when file does not exist", async () => {
    const harness = await createSnapshotHarness();

    const snapshots = await harness.manager.list();

    expect(snapshots).toEqual([]);
  });

  it("records metadata.diskFormat and metadata.qmpSocket in snapshot", async () => {
    const harness = await createSnapshotHarness();

    await harness.manager.create();

    const manifest = await readJson<ArtifactManifest>(harness.config.artifacts.manifestPath);
    const snapshot = manifest.artifacts.find((a): a is SnapshotRecord => a.kind === "snapshot");
    expect(snapshot?.metadata).toMatchObject({
      diskFormat: harness.plan.disk.format,
      qmpSocket: expect.any(String) as unknown,
    });
  });

  it("create non-clean-base with offline fallback records clean=false", async () => {
    const harness = await createSnapshotHarness({ qmpConnectError: new Error("no qmp") });

    const result = await harness.manager.create("user-snap");

    expect(result.snapshot).toMatchObject({
      name: "user-snap",
      clean: false,
      mode: "offline-qcow2",
    });
  });
});

type HarnessOptions = {
  readonly qmpConnectError?: Error;
  readonly qmpFailureCommand?: string;
  readonly processExitCode?: number;
};

async function createSnapshotHarness(options: HarnessOptions = {}) {
  const root = await createTempDir();
  const config = parseCrucibleConfig({
    vm: { name: "snapshot-test" },
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
  const qmp = new FakeQmpSession(options.qmpConnectError, options.qmpFailureCommand);
  const processCommands: ProcessCommand[] = [];
  const processRunner: ProcessRunner = {
    run(command) {
      processCommands.push(command);
      return Promise.resolve({
        command,
        exitCode: options.processExitCode ?? 0,
        signal: null,
        stdout: "",
        stderr: options.processExitCode === undefined ? "" : "qemu-img failed",
        durationMs: 1,
        timedOut: false,
      });
    },
  };
  const qmpClientFactory: VmQmpClientFactory = () => qmp;
  const manager = new SnapshotManager({
    config,
    plan,
    qmpClientFactory,
    processRunner,
    now: () => new Date("2026-05-27T00:00:00.000Z"),
  });

  return { config, manager, plan, processCommands, qmp };
}

class FakeQmpSession implements VmQmpSession {
  readonly calls: Array<{
    readonly command: string;
    readonly args: Readonly<Record<string, unknown>> | undefined;
  }> = [];

  constructor(
    public connectError?: Error,
    readonly failureCommand?: string,
  ) {}

  connect(): Promise<unknown> {
    if (this.connectError !== undefined) {
      return Promise.reject(this.connectError);
    }
    return Promise.resolve({});
  }

  execute<T = unknown>(
    command: string,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly returnValue: T }> {
    this.calls.push({ command, args });
    if (command === this.failureCommand) {
      return Promise.reject(new Error(`${command} failed`));
    }
    return Promise.resolve({ returnValue: {} as T });
  }

  close(): void {
    return undefined;
  }
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeManifest(filePath: string, manifest: ArtifactManifest): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(manifest), "utf8");
}

function snapshotRecord(record: SnapshotRecord): SnapshotRecord {
  return record;
}
