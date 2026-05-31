import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultCrucibleConfig, type CrucibleConfig } from "./config.js";
import { CrucibleError } from "./errors.js";
import { buildLifecyclePaths, type VmQmpClientFactory, type VmQmpSession } from "./lifecycle.js";
import {
  createEmptyArtifactManifest,
  type ArtifactManifest,
  type SnapshotRecord,
  upsertArtifactRecord,
} from "./manifest.js";
import type { ProcessCommand, ProcessResult, ProcessRunner } from "./process.js";
import { buildQemuCommandPlan, type QemuCommandPlan } from "./qemu.js";
import { QmpClient } from "./qmp.js";

export const CLEAN_BASE_SNAPSHOT_NAME = "clean-base";
const DEFAULT_QEMU_IMG_TIMEOUT_MS = 30_000;

const jobIdSuffix = (): string => `${Date.now()}-${randomBytes(4).toString("hex")}`;

export type SnapshotMode = "online-qmp" | "offline-qcow2";

export type SnapshotCreateResult = {
  readonly snapshot: SnapshotRecord;
  readonly qmpCommands: readonly string[];
  readonly qcow2Commands: readonly ProcessCommand[];
};

export type SnapshotRestoreResult = SnapshotCreateResult & {
  readonly restoredAt: string;
};

export type SnapshotManagerOptions = {
  readonly config?: CrucibleConfig;
  readonly plan?: QemuCommandPlan;
  readonly qmpClientFactory?: VmQmpClientFactory;
  readonly processRunner?: ProcessRunner;
  readonly now?: () => Date;
  readonly qemuImgExecutable?: string;
  readonly qemuImgTimeoutMs?: number;
};

export class SnapshotManager {
  readonly #config: CrucibleConfig;
  readonly #plan: QemuCommandPlan;
  readonly #qmpClientFactory: VmQmpClientFactory;
  readonly #processRunner: ProcessRunner;
  readonly #now: () => Date;
  readonly #qemuImgExecutable: string;
  readonly #qemuImgTimeoutMs: number;

  constructor(options: SnapshotManagerOptions = {}) {
    this.#config = options.config ?? defaultCrucibleConfig;
    this.#plan = options.plan ?? buildQemuCommandPlan({ config: this.#config });
    this.#qmpClientFactory = options.qmpClientFactory ?? defaultQmpClientFactory;
    this.#processRunner = options.processRunner ?? defaultProcessRunner;
    this.#now = options.now ?? (() => new Date());
    this.#qemuImgExecutable = options.qemuImgExecutable ?? "qemu-img";
    this.#qemuImgTimeoutMs = options.qemuImgTimeoutMs ?? DEFAULT_QEMU_IMG_TIMEOUT_MS;
  }

  async create(name = CLEAN_BASE_SNAPSHOT_NAME): Promise<SnapshotCreateResult> {
    const snapshotName = normalizeSnapshotName(name);
    await this.#assertCanCreateSnapshot(snapshotName);
    await this.#ensureSnapshotDirectory();
    const qmpCommands: string[] = [];
    const qcow2Commands: ProcessCommand[] = [];
    let mode: SnapshotMode;

    const qmp = this.#qmpClientFactory(this.#paths.qmpSocket, this.#config.qmp.timeoutMs);
    try {
      await qmp.connect();
      await executeQmp(qmp, "stop", undefined, this.#config.qmp.timeoutMs, qmpCommands);
      await executeQmp(
        qmp,
        "snapshot-save",
        {
          // QMP `snapshot-save` requires a unique job-id (any string),
          // a `tag` (snapshot name), `vmstate` (block-node where the
          // CPU/memory state is saved; must be a writable qcow2 node),
          // and `devices` (block-node names whose data is captured).
          // The CRUCIBLE disk node id is configured in QemuCommandPlan
          // via -drive ...,id=crucible-disk0; that node holds both the
          // VM state and the data, so it's the same id for both.
          "job-id": `crucible-snapshot-save-${jobIdSuffix()}`,
          tag: snapshotName,
          vmstate: "crucible-disk0",
          devices: ["crucible-disk0"],
        },
        this.#config.qmp.timeoutMs,
        qmpCommands,
      );
      await executeQmp(qmp, "cont", undefined, this.#config.qmp.timeoutMs, qmpCommands);
      mode = "online-qmp";
    } catch (error) {
      if (qmpCommands.length > 0) {
        await tryResume(qmp, this.#config.qmp.timeoutMs);
        throw error;
      }
      const command = this.#qemuImgCommand(["snapshot", "-c", snapshotName, this.#plan.disk.path]);
      qcow2Commands.push(command);
      await runChecked(this.#processRunner, command);
      mode = "offline-qcow2";
    } finally {
      qmp.close();
    }

    const snapshot = await this.#writeSnapshotRecord(snapshotName, mode);
    return { snapshot, qmpCommands, qcow2Commands };
  }

  async list(): Promise<readonly SnapshotRecord[]> {
    const manifest = await this.#readManifest();
    return manifest.artifacts
      .filter(isSnapshotRecord)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async restore(name = CLEAN_BASE_SNAPSHOT_NAME): Promise<SnapshotRestoreResult> {
    const snapshotName = normalizeSnapshotName(name);
    const snapshot = await this.#findSnapshot(snapshotName);
    this.#validateSnapshotDisk(snapshot);
    const snapshotMode = snapshot.mode ?? "offline-qcow2";
    const qmpCommands: string[] = [];
    const qcow2Commands: ProcessCommand[] = [];
    const qmp = this.#qmpClientFactory(this.#paths.qmpSocket, this.#config.qmp.timeoutMs);

    try {
      try {
        await qmp.connect();
      } catch (error) {
        if (snapshotMode === "online-qmp") {
          throw error;
        }
        const command = this.#qemuImgCommand([
          "snapshot",
          "-a",
          snapshotName,
          snapshot.baseDiskPath,
        ]);
        qcow2Commands.push(command);
        await runChecked(this.#processRunner, command);
        return await this.#recordRestore(snapshotName, snapshotMode, qmpCommands, qcow2Commands);
      }

      await executeQmp(qmp, "stop", undefined, this.#config.qmp.timeoutMs, qmpCommands);
      await executeQmp(
        qmp,
        "snapshot-load",
        {
          "job-id": `crucible-snapshot-load-${jobIdSuffix()}`,
          tag: snapshotName,
          vmstate: "crucible-disk0",
          devices: ["crucible-disk0"],
        },
        this.#config.qmp.timeoutMs,
        qmpCommands,
      );
      await executeQmp(qmp, "cont", undefined, this.#config.qmp.timeoutMs, qmpCommands);
    } finally {
      qmp.close();
    }

    return await this.#recordRestore(snapshotName, snapshotMode, qmpCommands, qcow2Commands);
  }

  async #recordRestore(
    snapshotName: string,
    mode: SnapshotMode,
    qmpCommands: readonly string[],
    qcow2Commands: readonly ProcessCommand[],
  ): Promise<SnapshotRestoreResult> {
    const restoredAt = this.#nowIso();
    const restoredSnapshot = await this.#writeSnapshotRecord(snapshotName, mode, restoredAt);
    return { snapshot: restoredSnapshot, restoredAt, qmpCommands, qcow2Commands };
  }

  get #paths() {
    return buildLifecyclePaths(this.#config);
  }

  async #ensureSnapshotDirectory(): Promise<void> {
    await mkdir(this.#config.artifacts.snapshotsDirectory, { recursive: true });
  }

  async #assertCanCreateSnapshot(snapshotName: string): Promise<void> {
    if (snapshotName !== CLEAN_BASE_SNAPSHOT_NAME) {
      return;
    }
    const manifest = await this.#readManifest();
    const existing = manifest.artifacts.find(
      (record) => isSnapshotRecord(record) && record.name === CLEAN_BASE_SNAPSHOT_NAME,
    );
    if (existing !== undefined) {
      throw new CrucibleError(
        "STATE_INVALID",
        "clean-base snapshot already exists; refusing to overwrite protected baseline",
        { snapshotName },
      );
    }
  }

  #qemuImgCommand(args: readonly string[]): ProcessCommand {
    return {
      executable: this.#qemuImgExecutable,
      args,
      timeoutMs: this.#qemuImgTimeoutMs,
      maxOutputBytes: 1024 * 1024,
    };
  }

  async #findSnapshot(name: string): Promise<SnapshotRecord> {
    const snapshot = (await this.list()).find((record) => record.name === name);
    if (snapshot === undefined) {
      throw new CrucibleError("STATE_INVALID", `Snapshot not found: ${name}`, { name });
    }
    return snapshot;
  }

  #validateSnapshotDisk(snapshot: SnapshotRecord): void {
    if (path.resolve(snapshot.baseDiskPath) !== path.resolve(this.#plan.disk.path)) {
      throw new CrucibleError(
        "STATE_INVALID",
        "Snapshot base disk does not match current VM disk",
        {
          snapshot: snapshot.name,
          snapshotBaseDiskPath: snapshot.baseDiskPath,
          currentDiskPath: this.#plan.disk.path,
        },
      );
    }
  }

  async #writeSnapshotRecord(
    name: string,
    mode: SnapshotMode = "offline-qcow2",
    restoredAt?: string,
  ): Promise<SnapshotRecord> {
    const manifest = await this.#readManifest();
    const now = this.#nowIso();
    const snapshot: SnapshotRecord = {
      kind: "snapshot",
      name,
      path: this.#plan.disk.path,
      createdAt: restoredAt === undefined ? now : (findExistingCreatedAt(name, manifest) ?? now),
      baseDiskPath: this.#plan.disk.path,
      clean: name === CLEAN_BASE_SNAPSHOT_NAME,
      qemuTag: name,
      mode,
      restoredAt,
      metadata: {
        diskFormat: this.#plan.disk.format,
        diskBus: this.#plan.disk.bus,
        qmpSocket: this.#paths.qmpSocket,
      },
    };

    await this.#writeManifest(upsertArtifactRecord(manifest, snapshot));
    return snapshot;
  }

  async #readManifest(): Promise<ArtifactManifest> {
    try {
      return JSON.parse(await readFile(this.#paths.artifactManifest, "utf8")) as ArtifactManifest;
    } catch (error) {
      if (isMissingPathError(error)) {
        return createEmptyArtifactManifest(this.#config.vm.name);
      }
      throw error;
    }
  }

  async #writeManifest(manifest: ArtifactManifest): Promise<void> {
    await mkdir(path.dirname(this.#paths.artifactManifest), { recursive: true });
    await writeFile(
      this.#paths.artifactManifest,
      `${JSON.stringify(manifest, undefined, 2)}\n`,
      "utf8",
    );
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }
}

export function normalizeSnapshotName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new CrucibleError(
      "CONFIG_INVALID",
      "Snapshot names must be 1-64 characters of letters, numbers, '.', '_', or '-' and start with a letter or number",
      { name },
    );
  }
  return name;
}

async function executeQmp(
  qmp: VmQmpSession,
  command: string,
  args: Readonly<Record<string, unknown>> | undefined,
  timeoutMs: number,
  commands: string[],
): Promise<void> {
  commands.push(command);
  await qmp.execute(command, args, { timeoutMs });
}

async function tryResume(qmp: VmQmpSession, timeoutMs: number): Promise<void> {
  try {
    await qmp.execute("cont", undefined, { timeoutMs });
  } catch {
    return undefined;
  }
}

async function runChecked(processRunner: ProcessRunner, command: ProcessCommand): Promise<void> {
  const result = await processRunner.run(command);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new CrucibleError("PROCESS_FAILED", "qemu-img snapshot command failed", {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stderr: result.stderr,
    });
  }
}

const defaultProcessRunner: ProcessRunner = {
  run(command) {
    return runProcess(command);
  },
};

async function runProcess(command: ProcessCommand): Promise<ProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env === undefined ? process.env : { ...process.env, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const maxOutputBytes = command.maxOutputBytes ?? 1024 * 1024;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, command.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = boundedAppend(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = boundedAppend(stderr, chunk, maxOutputBytes);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

function boundedAppend(current: string, chunk: string, maxBytes: number): string {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return next;
  }
  return next.slice(-maxBytes);
}

function findExistingCreatedAt(name: string, manifest: ArtifactManifest): string | undefined {
  return manifest.artifacts.find(
    (artifact): artifact is SnapshotRecord => isSnapshotRecord(artifact) && artifact.name === name,
  )?.createdAt;
}

function defaultQmpClientFactory(socketPath: string, timeoutMs: number): VmQmpSession {
  return new QmpClient({ socketPath, timeoutMs });
}

function isSnapshotRecord(record: unknown): record is SnapshotRecord {
  return (
    typeof record === "object" &&
    record !== null &&
    "kind" in record &&
    record.kind === "snapshot" &&
    "name" in record &&
    typeof record.name === "string" &&
    "path" in record &&
    typeof record.path === "string" &&
    "createdAt" in record &&
    typeof record.createdAt === "string" &&
    "baseDiskPath" in record &&
    typeof record.baseDiskPath === "string" &&
    "clean" in record &&
    typeof record.clean === "boolean" &&
    (!("mode" in record) || record.mode === "online-qmp" || record.mode === "offline-qcow2") &&
    (!("qemuTag" in record) || typeof record.qemuTag === "string") &&
    (!("restoredAt" in record) || typeof record.restoredAt === "string")
  );
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
