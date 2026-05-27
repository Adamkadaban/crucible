import { mkdir } from "node:fs/promises";
import path from "node:path";

import { defaultCrucibleConfig, type CrucibleConfig } from "./config.js";
import { CrucibleError } from "./errors.js";
import {
  dedupeArtifacts,
  readArtifactManifestOrCreate,
  type SnapshotRecord,
  writeArtifactManifest,
  writeJson,
} from "./manifest.js";
import { type VmQmpClientFactory, type VmQmpSession } from "./lifecycle.js";
import { QmpClient } from "./qmp.js";
import { buildQemuCommandPlan } from "./qemu.js";

export type SnapshotOperation = "create" | "restore";

export type SnapshotCommandResult = {
  readonly operation: SnapshotOperation;
  readonly snapshotName: string;
  readonly qmpCommand: "savevm" | "loadvm";
  readonly baseDiskPath: string;
  readonly metadataPath: string;
  readonly artifactManifestPath: string;
  readonly clean: boolean;
};

export type SnapshotManagerOptions = {
  readonly config?: CrucibleConfig;
  readonly qmpClientFactory?: VmQmpClientFactory;
  readonly now?: () => Date;
};

export class SnapshotManager {
  readonly #config: CrucibleConfig;
  readonly #qmpClientFactory: VmQmpClientFactory;
  readonly #now: () => Date;

  constructor(options: SnapshotManagerOptions = {}) {
    this.#config = options.config ?? defaultCrucibleConfig;
    this.#qmpClientFactory = options.qmpClientFactory ?? defaultQmpClientFactory;
    this.#now = options.now ?? (() => new Date());
  }

  async create(snapshotName: string): Promise<SnapshotCommandResult> {
    return this.#runSnapshotCommand("create", snapshotName, "savevm");
  }

  async restore(snapshotName: string): Promise<SnapshotCommandResult> {
    return this.#runSnapshotCommand("restore", snapshotName, "loadvm");
  }

  async #runSnapshotCommand(
    operation: SnapshotOperation,
    snapshotName: string,
    qmpCommand: "savevm" | "loadvm",
  ): Promise<SnapshotCommandResult> {
    validateSnapshotName(snapshotName);
    const plan = buildQemuCommandPlan({ config: this.#config });
    const metadataPath = this.#snapshotMetadataPath(snapshotName);
    const createdAt = this.#now().toISOString();
    const qmp = this.#qmpClientFactory(this.#config.qmp.socketPath, this.#config.qmp.timeoutMs);

    try {
      await qmp.connect();
      await qmp.execute("human-monitor-command", {
        "command-line": `${qmpCommand} ${snapshotName}`,
      });
    } finally {
      qmp.close();
    }

    await mkdir(path.dirname(metadataPath), { recursive: true });
    const result: SnapshotCommandResult = {
      operation,
      snapshotName,
      qmpCommand,
      baseDiskPath: plan.disk.path,
      metadataPath,
      artifactManifestPath: this.#config.artifacts.manifestPath,
      clean: snapshotName === "clean-base",
    };
    await writeJson(metadataPath, { version: 1, createdAt, ...result });
    await appendSnapshotArtifact(this.#config, {
      kind: "snapshot",
      name: snapshotName,
      path: metadataPath,
      createdAt,
      baseDiskPath: plan.disk.path,
      clean: result.clean,
      metadata: {
        qmpCommand,
        qcow2InternalSnapshot: true,
      },
    });

    return result;
  }

  #snapshotMetadataPath(snapshotName: string): string {
    return path.join(
      this.#config.artifacts.snapshotsDirectory,
      this.#config.vm.name,
      `${snapshotName}.json`,
    );
  }
}

async function appendSnapshotArtifact(
  config: CrucibleConfig,
  snapshot: SnapshotRecord,
): Promise<void> {
  const existing = await readArtifactManifestOrCreate(
    config.artifacts.manifestPath,
    config.vm.name,
  );
  await writeArtifactManifest(config.artifacts.manifestPath, {
    version: 1,
    vmName: config.vm.name,
    artifacts: dedupeArtifacts([...existing.artifacts, snapshot]),
  });
}

function validateSnapshotName(snapshotName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(snapshotName)) {
    throw new CrucibleError(
      "CONFIG_INVALID",
      "Snapshot names must be 1-64 characters of letters, digits, '.', '_', or '-' and start with a letter or digit",
      { snapshotName },
    );
  }
}

function defaultQmpClientFactory(socketPath: string, timeoutMs: number): VmQmpSession {
  return new QmpClient({ socketPath, timeoutMs });
}
