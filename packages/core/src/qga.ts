import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";

import { CrucibleError } from "./errors.js";
import {
  buildProvisioningSecretStorageContract,
  type ProvisioningExecutor,
  type ProvisioningSecretKind,
  type ProvisioningStageContract,
} from "./provisioning.js";

const DEFAULT_QGA_TIMEOUT_MS = 10_000;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

type QgaResponse<T> = { readonly return?: T; readonly error?: { readonly desc?: string } };

export type QgaClientOptions = {
  readonly socketPath: string;
  readonly timeoutMs?: number;
};

export type QgaGuestExecResult = {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export class QgaClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;

  constructor(options: QgaClientOptions) {
    this.#socketPath = options.socketPath;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QGA_TIMEOUT_MS;
  }

  async ping(): Promise<void> {
    await this.#request("guest-ping", {});
  }

  async exec(
    executablePath: string,
    args: readonly string[],
    options: { readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> } = {},
  ): Promise<QgaGuestExecResult> {
    const started = await this.#request<{ readonly pid: number }>("guest-exec", {
      path: executablePath,
      arg: args,
      env: Object.entries(options.env ?? {}).map(([name, value]) => `${name}=${value}`),
      "capture-output": true,
    });
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);

    while (Date.now() < deadline) {
      const status = await this.#request<{
        readonly exited: boolean;
        readonly exitcode?: number;
        readonly "out-data"?: string;
        readonly "err-data"?: string;
      }>("guest-exec-status", { pid: started.pid });

      if (status.exited) {
        return {
          exitCode: status.exitcode,
          stdout: decodeBase64(status["out-data"]),
          stderr: decodeBase64(status["err-data"]),
          timedOut: false,
        };
      }

      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    return { stdout: "", stderr: "", timedOut: true };
  }

  async #request<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const socket = await connectSocket(this.#socketPath, this.#timeoutMs);
    try {
      socket.write(`${JSON.stringify({ execute: command, arguments: args })}\r\n`);
      const response = await readResponse<T>(socket, this.#timeoutMs);
      if (response.error !== undefined) {
        throw new CrucibleError("PROCESS_FAILED", `QGA command failed: ${command}`, response.error);
      }
      return response.return as T;
    } finally {
      socket.end();
    }
  }
}

export type QgaProvisioningExecutorOptions = {
  readonly client: QgaClient;
  readonly vmName: string;
  readonly secretsDirectory: string;
  readonly timeoutMs?: number;
};

export class QgaProvisioningExecutor implements ProvisioningExecutor {
  readonly #client: QgaClient;
  readonly #vmName: string;
  readonly #secretsDirectory: string;
  readonly #timeoutMs: number;

  constructor(options: QgaProvisioningExecutorOptions) {
    this.#client = options.client;
    this.#vmName = options.vmName;
    this.#secretsDirectory = options.secretsDirectory;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  }

  async runStage(stage: ProvisioningStageContract) {
    if (stage.id === "media-ready" || stage.id === "vm-booted") {
      return {
        id: stage.id,
        title: stage.title,
        status: "succeeded" as const,
        detail: "host-side stage satisfied before QGA execution",
      };
    }

    if (stage.id === "qga-ready") {
      await this.#client.ping();
      if (stage.script === undefined) {
        return {
          id: stage.id,
          title: stage.title,
          status: "succeeded" as const,
          detail: "QGA guest-ping succeeded",
        };
      }
    }

    if (stage.script === undefined) {
      return {
        id: stage.id,
        title: stage.title,
        status: "succeeded" as const,
        detail: "readiness contract has no script",
      };
    }

    const env = await this.#buildStageEnv(stage.script.environmentSecretRefs);
    const args = await buildPowerShellStageArgs(stage.script.scriptPath);
    const result = await this.#client.exec(stage.script.executable, args, {
      timeoutMs: Math.max(stage.script.timeoutMs, this.#timeoutMs),
      env,
    });

    return {
      id: stage.id,
      title: stage.title,
      status:
        result.exitCode === 0 && !result.timedOut ? ("succeeded" as const) : ("blocked" as const),
      detail: result.timedOut
        ? "QGA guest-exec timed out"
        : result.exitCode === 0
          ? stage.script.scriptPath
          : result.stderr || `guest-exec exit code ${result.exitCode ?? "unknown"}`,
    };
  }

  async #buildStageEnv(
    secretRefs: readonly ProvisioningSecretKind[],
  ): Promise<Readonly<Record<string, string>>> {
    const contract = buildProvisioningSecretStorageContract(this.#vmName, this.#secretsDirectory);
    const env: Record<string, string> = {};

    for (const secretRef of secretRefs) {
      const ref = contract.secretRefs.find((entry) => entry.kind === secretRef);
      if (ref === undefined) {
        throw new CrucibleError("STATE_INVALID", `Missing secret reference: ${secretRef}`);
      }
      const parsed = JSON.parse(await readFile(ref.path, "utf8")) as {
        readonly password?: unknown;
      };
      if (typeof parsed.password !== "string") {
        throw new CrucibleError("STATE_INVALID", `Secret file lacks password: ${secretRef}`);
      }
      if (secretRef === "windows-standard-password") {
        env.CRUCIBLE_STANDARD_PASSWORD = parsed.password;
      }
      if (secretRef === "windows-admin-password") {
        env.CRUCIBLE_ADMIN_PASSWORD = parsed.password;
      }
    }

    return env;
  }
}

async function buildPowerShellStageArgs(scriptPath: string): Promise<readonly string[]> {
  const script = await readFile(scriptPath, "utf8");
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new CrucibleError("PROCESS_TIMEOUT", `Timed out connecting to QGA: ${socketPath}`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(new CrucibleError("PROCESS_FAILED", `Unable to connect to QGA: ${socketPath}`, error));
    });
  });
}

function readResponse<T>(socket: Socket, timeoutMs: number): Promise<QgaResponse<T>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      reject(new CrucibleError("PROCESS_TIMEOUT", "Timed out waiting for QGA response"));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as QgaResponse<T>);
      } catch (error) {
        reject(new CrucibleError("QMP_PARSE_ERROR", "Unable to parse QGA response", error));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(new CrucibleError("PROCESS_FAILED", "QGA socket error", error));
    });
  });
}

function decodeBase64(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
