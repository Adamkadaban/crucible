import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultCrucibleConfig, type CrucibleConfig } from "./config.js";
import { CrucibleError } from "./errors.js";
import {
  createEmptyArtifactManifest,
  type ArtifactManifest,
  type ArtifactRecord,
} from "./manifest.js";
import { QmpClient, type QmpCommandOptions } from "./qmp.js";
import { buildQemuCommandPlan, type QemuCommandPlan } from "./qemu.js";

const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

export type VmLifecycleState = "stopped" | "starting" | "running" | "stopping" | "poweredOff";

export type VmLifecyclePaths = {
  readonly stateManifest: string;
  readonly artifactManifest: string;
  readonly pidFile: string;
  readonly qmpSocket: string;
  readonly qgaSocket: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
};

export type VmLifecycleStateManifest = {
  readonly version: 1;
  readonly vmName: string;
  readonly state: VmLifecycleState;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly lastTransitionAt: string;
  readonly paths: VmLifecyclePaths;
  readonly qemu: {
    readonly executable: string;
    readonly args: readonly string[];
  };
};

export type VmRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "poweredOff"
  | "stale";

export type VmStatus = {
  readonly status: VmRuntimeStatus;
  readonly pid?: number;
  readonly processAlive: boolean;
  readonly qmpAvailable: boolean;
  readonly qmpStatus?: string;
  readonly stateManifest?: VmLifecycleStateManifest;
  readonly paths: VmLifecyclePaths;
  readonly warnings: readonly string[];
};

export type VmStartResult = {
  readonly status: VmStatus;
  readonly pid: number;
};

export type VmStopMode = "stop" | "poweroff";

export type VmStopResult = {
  readonly status: VmStatus;
  readonly mode: VmStopMode;
  readonly qmpCommandSent: boolean;
  readonly signalSent?: NodeJS.Signals;
  readonly killedAfterTimeout: boolean;
};

export type VmCleanupResult = {
  readonly removedPaths: readonly string[];
  readonly status: VmStatus;
};

export type SpawnedVmProcess = {
  readonly pid: number;
};

export type VmProcessSpawner = {
  readonly spawn: (request: VmSpawnRequest) => Promise<SpawnedVmProcess>;
};

export type VmSpawnRequest = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdoutLog: string;
  readonly stderrLog: string;
};

export type VmProcessController = {
  readonly isAlive: (pid: number) => boolean;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly waitForExit: (
    pid: number,
    timeoutMs: number,
    pollIntervalMs: number,
  ) => Promise<boolean>;
};

export type VmQmpSession = {
  readonly connect: () => Promise<unknown>;
  readonly execute: <T = unknown>(
    command: string,
    args?: Readonly<Record<string, unknown>>,
    options?: QmpCommandOptions,
  ) => Promise<{ readonly returnValue: T }>;
  readonly close: () => void;
};

export type VmQmpClientFactory = (socketPath: string, timeoutMs: number) => VmQmpSession;

export type VmLifecycleManagerOptions = {
  readonly config?: CrucibleConfig;
  readonly plan?: QemuCommandPlan;
  readonly spawner?: VmProcessSpawner;
  readonly processController?: VmProcessController;
  readonly qmpClientFactory?: VmQmpClientFactory;
  readonly now?: () => Date;
  readonly stopTimeoutMs?: number;
  readonly killTimeoutMs?: number;
  readonly pollIntervalMs?: number;
};

export class VmLifecycleManager {
  readonly #config: CrucibleConfig;
  readonly #plan: QemuCommandPlan;
  readonly #spawner: VmProcessSpawner;
  readonly #processController: VmProcessController;
  readonly #qmpClientFactory: VmQmpClientFactory;
  readonly #now: () => Date;
  readonly #stopTimeoutMs: number;
  readonly #killTimeoutMs: number;
  readonly #pollIntervalMs: number;

  constructor(options: VmLifecycleManagerOptions = {}) {
    this.#config = options.config ?? defaultCrucibleConfig;
    this.#plan = options.plan ?? buildQemuCommandPlan({ config: this.#config });
    this.#spawner = options.spawner ?? defaultVmProcessSpawner;
    this.#processController = options.processController ?? defaultVmProcessController;
    this.#qmpClientFactory = options.qmpClientFactory ?? defaultQmpClientFactory;
    this.#now = options.now ?? (() => new Date());
    this.#stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.#killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  get paths(): VmLifecyclePaths {
    return buildLifecyclePaths(this.#config);
  }

  async start(): Promise<VmStartResult> {
    const current = await this.status({ queryQmp: false });
    if (current.processAlive) {
      throw new CrucibleError("STATE_INVALID", "VM is already running", {
        pid: current.pid,
        status: current.status,
      });
    }

    await this.cleanupStaleResources();
    await this.#ensureDirectories();

    const starting = this.#buildStateManifest("starting");
    await this.#writeStateManifest(starting);
    await this.#writeArtifactManifest();

    const spawned = await this.#spawner.spawn({
      executable: this.#plan.executable,
      args: this.#plan.args,
      stdoutLog: this.paths.stdoutLog,
      stderrLog: this.paths.stderrLog,
    });

    await writeFile(this.paths.pidFile, `${spawned.pid}\n`, "utf8");
    await this.#writeStateManifest(
      this.#buildStateManifest("running", {
        pid: spawned.pid,
        startedAt: starting.startedAt ?? starting.lastTransitionAt,
      }),
    );

    return { pid: spawned.pid, status: await this.status() };
  }

  async stop(): Promise<VmStopResult> {
    return this.#stopWithMode("stop");
  }

  async poweroff(): Promise<VmStopResult> {
    return this.#stopWithMode("poweroff");
  }

  async kill(): Promise<VmStopResult> {
    const current = await this.status({ queryQmp: false });
    if (current.pid === undefined || !current.processAlive) {
      const status = await this.#markStopped("stopped");
      return {
        status,
        mode: "stop",
        qmpCommandSent: false,
        killedAfterTimeout: false,
      };
    }

    this.#signal(current.pid, "SIGKILL");
    await this.#processController.waitForExit(
      current.pid,
      this.#killTimeoutMs,
      this.#pollIntervalMs,
    );
    const status = await this.#markStopped("stopped");
    return {
      status,
      mode: "stop",
      qmpCommandSent: false,
      signalSent: "SIGKILL",
      killedAfterTimeout: true,
    };
  }

  async status(options: { readonly queryQmp?: boolean } = {}): Promise<VmStatus> {
    const paths = this.paths;
    const stateManifest = await readJsonIfExists<VmLifecycleStateManifest>(paths.stateManifest);
    const pid = stateManifest?.pid ?? (await readPidFile(paths.pidFile));
    const processAlive = pid !== undefined && this.#processController.isAlive(pid);
    const warnings: string[] = [];
    let qmpAvailable = false;
    let qmpStatus: string | undefined;

    if (processAlive && options.queryQmp !== false) {
      const qmp = this.#qmpClientFactory(paths.qmpSocket, this.#config.qmp.timeoutMs);
      try {
        await qmp.connect();
        const result = await qmp.execute<{ readonly status?: unknown }>("query-status", undefined, {
          timeoutMs: this.#config.qmp.timeoutMs,
        });
        qmpAvailable = true;
        if (typeof result.returnValue.status === "string") {
          qmpStatus = result.returnValue.status;
        }
      } catch (error) {
        warnings.push(formatStatusWarning(error));
      } finally {
        qmp.close();
      }
    }

    return {
      status: deriveRuntimeStatus(stateManifest?.state, pid, processAlive),
      pid,
      processAlive,
      qmpAvailable,
      qmpStatus,
      stateManifest,
      paths,
      warnings,
    };
  }

  async cleanupStaleResources(): Promise<VmCleanupResult> {
    const before = await this.status({ queryQmp: false });
    const removedPaths: string[] = [];

    if (before.processAlive) {
      return { removedPaths, status: before };
    }

    for (const resourcePath of [this.paths.pidFile, this.paths.qmpSocket, this.paths.qgaSocket]) {
      if (!isProjectOwnedPath(resourcePath, this.#config, this.paths)) {
        continue;
      }
      if (await removeIfExists(resourcePath)) {
        removedPaths.push(resourcePath);
      }
    }

    if (before.status === "stale" || before.stateManifest !== undefined) {
      await this.#writeStateManifest(this.#buildStateManifest("stopped"));
    }

    return { removedPaths, status: await this.status({ queryQmp: false }) };
  }

  async #stopWithMode(mode: VmStopMode): Promise<VmStopResult> {
    const current = await this.status({ queryQmp: false });
    const stoppedState = mode === "poweroff" ? "poweredOff" : "stopped";

    if (current.pid === undefined || !current.processAlive) {
      return {
        status: await this.#markStopped(stoppedState),
        mode,
        qmpCommandSent: false,
        killedAfterTimeout: false,
      };
    }

    await this.#writeStateManifest(
      this.#buildStateManifest("stopping", {
        pid: current.pid,
        startedAt: current.stateManifest?.startedAt,
      }),
    );

    const qmpCommandSent = await this.#tryGracefulQmpCommand(
      mode === "poweroff" ? "system_powerdown" : "quit",
    );
    let signalSent: NodeJS.Signals | undefined;

    if (!qmpCommandSent) {
      signalSent = "SIGTERM";
      this.#signal(current.pid, signalSent);
    }

    const exited = await this.#processController.waitForExit(
      current.pid,
      this.#stopTimeoutMs,
      this.#pollIntervalMs,
    );
    let killedAfterTimeout = false;

    if (!exited && this.#processController.isAlive(current.pid)) {
      killedAfterTimeout = true;
      signalSent = "SIGKILL";
      this.#signal(current.pid, signalSent);
      await this.#processController.waitForExit(
        current.pid,
        this.#killTimeoutMs,
        this.#pollIntervalMs,
      );
    }

    return {
      status: await this.#markStopped(stoppedState),
      mode,
      qmpCommandSent,
      signalSent,
      killedAfterTimeout,
    };
  }

  async #tryGracefulQmpCommand(command: "quit" | "system_powerdown"): Promise<boolean> {
    const qmp = this.#qmpClientFactory(this.paths.qmpSocket, this.#config.qmp.timeoutMs);
    try {
      await withTimeout(qmp.connect(), this.#config.qmp.timeoutMs, "QMP connect timed out");
      await withTimeout(
        qmp.execute(command, undefined, { timeoutMs: this.#config.qmp.timeoutMs }),
        this.#config.qmp.timeoutMs,
        `QMP ${command} timed out`,
      );
      return true;
    } catch {
      return false;
    } finally {
      qmp.close();
    }
  }

  #signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.#processController.signal(pid, signal);
    } catch (error) {
      if (!isMissingProcessError(error)) {
        throw error;
      }
    }
  }

  async #markStopped(state: "stopped" | "poweredOff"): Promise<VmStatus> {
    await this.cleanupStaleResources();
    await this.#writeStateManifest(this.#buildStateManifest(state, { stoppedAt: this.#nowIso() }));
    return this.status({ queryQmp: false });
  }

  #buildStateManifest(
    state: VmLifecycleState,
    options: {
      readonly pid?: number;
      readonly startedAt?: string;
      readonly stoppedAt?: string;
    } = {},
  ): VmLifecycleStateManifest {
    const now = this.#nowIso();
    return {
      version: 1,
      vmName: this.#config.vm.name,
      state,
      pid: options.pid,
      startedAt:
        options.startedAt ?? (state === "starting" || state === "running" ? now : undefined),
      stoppedAt: options.stoppedAt,
      lastTransitionAt: now,
      paths: this.paths,
      qemu: {
        executable: this.#plan.executable,
        args: this.#plan.args,
      },
    };
  }

  async #ensureDirectories(): Promise<void> {
    await Promise.all(
      [
        path.dirname(this.paths.stateManifest),
        path.dirname(this.paths.artifactManifest),
        path.dirname(this.paths.pidFile),
        path.dirname(this.paths.stdoutLog),
        path.dirname(this.paths.stderrLog),
        path.dirname(this.paths.qmpSocket),
        path.dirname(this.paths.qgaSocket),
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
  }

  async #writeStateManifest(manifest: VmLifecycleStateManifest): Promise<void> {
    await mkdir(path.dirname(this.paths.stateManifest), { recursive: true });
    await writeJson(this.paths.stateManifest, manifest);
  }

  async #writeArtifactManifest(): Promise<void> {
    const existing =
      (await readJsonIfExists<ArtifactManifest>(this.paths.artifactManifest)) ??
      createEmptyArtifactManifest(this.#config.vm.name);
    const now = this.#nowIso();
    const artifacts: ArtifactRecord[] = [
      ...existing.artifacts,
      {
        kind: "disk",
        name: `${this.#config.vm.name} qcow2 disk`,
        path: this.#plan.disk.path,
        createdAt: now,
        metadata: { format: this.#plan.disk.format, bus: this.#plan.disk.bus },
      },
      { kind: "socket", name: "QMP socket", path: this.paths.qmpSocket, createdAt: now },
      { kind: "socket", name: "QGA socket", path: this.paths.qgaSocket, createdAt: now },
      { kind: "pidFile", name: "QEMU pid file", path: this.paths.pidFile, createdAt: now },
      { kind: "log", name: "QEMU stdout log", path: this.paths.stdoutLog, createdAt: now },
      { kind: "log", name: "QEMU stderr log", path: this.paths.stderrLog, createdAt: now },
    ];

    await mkdir(path.dirname(this.paths.artifactManifest), { recursive: true });
    await writeJson(this.paths.artifactManifest, {
      version: 1,
      vmName: this.#config.vm.name,
      artifacts: dedupeArtifacts(artifacts),
    });
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }
}

export function buildLifecyclePaths(
  config: CrucibleConfig = defaultCrucibleConfig,
): VmLifecyclePaths {
  return {
    stateManifest: path.join(config.artifacts.directory, "state", `${config.vm.name}.json`),
    artifactManifest: config.artifacts.manifestPath,
    pidFile: path.join(config.artifacts.directory, "run", `${config.vm.name}.pid`),
    qmpSocket: config.qmp.socketPath,
    qgaSocket: config.qga.socketPath,
    stdoutLog: path.join(config.artifacts.logsDirectory, `${config.vm.name}.stdout.log`),
    stderrLog: path.join(config.artifacts.logsDirectory, `${config.vm.name}.stderr.log`),
  };
}

async function readPidFile(pidFile: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    if (raw.length === 0) {
      return undefined;
    }
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

async function removeIfExists(filePath: string): Promise<boolean> {
  try {
    await rm(filePath, { force: false });
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function deriveRuntimeStatus(
  manifestState: VmLifecycleState | undefined,
  pid: number | undefined,
  processAlive: boolean,
): VmRuntimeStatus {
  if (pid !== undefined && !processAlive) {
    return "stale";
  }
  if (processAlive) {
    return manifestState === "starting" || manifestState === "stopping" ? manifestState : "running";
  }
  return manifestState ?? "stopped";
}

function formatStatusWarning(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function dedupeArtifacts(artifacts: readonly ArtifactRecord[]): readonly ArtifactRecord[] {
  return [
    ...new Map(
      artifacts.map((artifact) => [`${artifact.kind}:${artifact.path}`, artifact]),
    ).values(),
  ];
}

function isProjectOwnedPath(
  resourcePath: string,
  config: CrucibleConfig,
  paths: VmLifecyclePaths,
): boolean {
  const absoluteResource = path.resolve(resourcePath);
  const exactOwnedPaths = [
    paths.pidFile,
    paths.qmpSocket,
    paths.qgaSocket,
    paths.stateManifest,
    paths.artifactManifest,
  ].map((ownedPath) => path.resolve(ownedPath));

  if (exactOwnedPaths.includes(absoluteResource)) {
    return true;
  }

  return isInside(path.resolve(config.artifacts.directory), absoluteResource);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function defaultQmpClientFactory(socketPath: string, timeoutMs: number): VmQmpSession {
  return new QmpClient({ socketPath, timeoutMs });
}

const defaultVmProcessSpawner: VmProcessSpawner = {
  spawn(request) {
    const stdoutFd = openSync(request.stdoutLog, "a");
    const stderrFd = openSync(request.stderrLog, "a");
    let child;
    try {
      child = spawn(request.executable, [...request.args], {
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    child.unref();

    if (child.pid === undefined) {
      throw new CrucibleError("PROCESS_FAILED", "QEMU process did not report a pid");
    }

    return Promise.resolve({ pid: child.pid });
  },
};

const defaultVmProcessController: VmProcessController = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (isMissingProcessError(error)) {
        return false;
      }
      throw error;
    }
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
  async waitForExit(pid, timeoutMs, pollIntervalMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (!defaultVmProcessController.isAlive(pid)) {
        return true;
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    return !defaultVmProcessController.isAlive(pid);
  },
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new CrucibleError("QMP_TIMEOUT", message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isMissingProcessError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ESRCH";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
