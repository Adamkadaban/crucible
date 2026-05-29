import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { CrucibleError } from "./errors.js";
import {
  buildProvisioningSecretStorageContract,
  type ProvisioningExecutor,
  type ProvisioningSecretKind,
  type ProvisioningStageContract,
  type ProvisioningStageId,
} from "./provisioning.js";

const DEFAULT_QGA_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_QGA_READINESS_TIMEOUT_MS = 30 * 60 * 1000;
const QGA_READINESS_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

const DEFAULT_RETRY_BUDGET_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_INITIAL_BACKOFF_MS = 500;
const DEFAULT_RETRY_MAX_BACKOFF_MS = 5_000;

type QgaResponse<T> = {
  readonly return?: T;
  readonly error?: { readonly class?: string; readonly desc?: string };
};

export type QgaRetryPolicy = {
  readonly budgetMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
};

export type QgaClientOptions = {
  readonly socketPath: string;
  readonly timeoutMs?: number;
  readonly retryPolicy?: QgaRetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Aborting this signal cancels any in-flight retry sleep immediately and
   * makes subsequent calls reject with the signal's reason. Used by the
   * provisioning CLI to cut a 5-minute retry budget short the moment QEMU
   * is observed to have exited.
   */
  readonly signal?: AbortSignal;
};

export type QgaGuestExecResult = {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type QgaExecOptions = {
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * When set, the entire guest-exec + status-poll loop is retried if the
   * connection to qemu-ga drops mid-flight or if a status poll reports
   * "pid not found" (which happens after a Windows reboot restarts the
   * agent and forgets the in-flight pid). The caller is responsible for
   * ensuring the command itself is safe to re-execute.
   */
  readonly idempotent?: boolean;
};

export class QgaClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #retryPolicy: QgaRetryPolicy;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #signal: AbortSignal | undefined;

  constructor(options: QgaClientOptions) {
    this.#socketPath = options.socketPath;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QGA_TIMEOUT_MS;
    this.#retryPolicy = options.retryPolicy ?? {
      budgetMs: DEFAULT_RETRY_BUDGET_MS,
      initialBackoffMs: DEFAULT_RETRY_INITIAL_BACKOFF_MS,
      maxBackoffMs: DEFAULT_RETRY_MAX_BACKOFF_MS,
    };
    this.#sleep = options.sleep ?? sleep;
    this.#signal = options.signal;
  }

  /**
   * Single-shot guest-ping. Callers that need readiness polling (e.g.
   * QgaProvisioningExecutor#waitForGuestReadiness) loop ping themselves
   * with their own deadline, so this intentionally does NOT retry.
   */
  async ping(): Promise<void> {
    await this.#withConnection("guest-ping", async (conn) => {
      await conn.request("guest-ping", {});
    });
  }

  async exec(
    executablePath: string,
    args: readonly string[],
    options: QgaExecOptions = {},
  ): Promise<QgaGuestExecResult> {
    if (options.idempotent === true) {
      return this.#withRetry(`exec ${executablePath}`, () =>
        this.#execOnce(executablePath, args, options),
      );
    }
    return this.#execOnce(executablePath, args, options);
  }

  /**
   * writeFile is naturally idempotent (same path, same bytes, mode=wb
   * truncates on open) so the whole open + write + close sequence is
   * always retried under the configured policy. The open/write/close
   * runs over a SINGLE QGA connection so qemu-ga's global handle table
   * (qga/commands-win32.c guest_file_state.filehandles) sees a clean
   * sequence and never leaks handles — Windows qemu-ga has no per-client
   * cleanup on disconnect, so issuing open and close on separate sockets
   * leaves the file open forever on the guest, causing every retry to
   * fail with ERROR_SHARING_VIOLATION against qemu-ga's own handle.
   */
  async writeFile(guestPath: string, contents: Buffer | string): Promise<void> {
    const data = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
    return this.#withRetry(`writeFile ${guestPath}`, () => this.#writeFileOnce(guestPath, data));
  }

  async #execOnce(
    executablePath: string,
    args: readonly string[],
    options: QgaExecOptions,
  ): Promise<QgaGuestExecResult> {
    const execArgs: Record<string, unknown> = {
      path: executablePath,
      arg: args,
      "capture-output": true,
    };
    // qemu-ga's guest-exec replaces the entire environment when env is set.
    // Passing an empty list strips PATH/SystemRoot and breaks loaders like
    // powershell.exe. Only forward env when the caller actually has vars to
    // inject so the inherited Windows environment is preserved otherwise.
    const envEntries = Object.entries(options.env ?? {});
    if (envEntries.length > 0) {
      execArgs.env = envEntries.map(([name, value]) => `${name}=${value}`);
    }
    // guest-exec returns a pid that survives across QGA connections —
    // qemu-ga stores it in a global table — so the status-poll loop can
    // use fresh connections without losing state.
    const started = await this.#withConnection("guest-exec", (conn) =>
      conn.request<{ readonly pid: number }>("guest-exec", execArgs),
    );
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);

    while (Date.now() < deadline) {
      const status = await this.#withConnection("guest-exec-status", (conn) =>
        conn.request<{
          readonly exited: boolean;
          readonly exitcode?: number;
          readonly "out-data"?: string;
          readonly "err-data"?: string;
        }>("guest-exec-status", { pid: started.pid }),
      );

      if (status.exited) {
        return {
          exitCode: status.exitcode,
          stdout: decodeBase64(status["out-data"]),
          stderr: decodeBase64(status["err-data"]),
          timedOut: false,
        };
      }

      await this.#sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    return { stdout: "", stderr: "", timedOut: true };
  }

  async #writeFileOnce(guestPath: string, data: Buffer): Promise<void> {
    // CRITICAL: open + write* + close MUST share one connection. Issuing
    // them on separate connections leaks the file handle inside qemu-ga
    // on Windows (no per-client cleanup) and every subsequent attempt
    // for the same path fails ERROR_SHARING_VIOLATION against the
    // orphaned handle.
    await this.#withConnection(`writeFile ${guestPath}`, async (conn) => {
      const opened = await conn.request<{ readonly handle: number }>("guest-file-open", {
        path: guestPath,
        mode: "wb",
      });
      let primaryError: unknown;
      try {
        // qemu-ga caps a single guest-file-write at 48 KiB by default,
        // so chunk larger payloads to stay within the limit.
        const chunkSize = 32 * 1024;
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          const chunk = data.subarray(offset, offset + chunkSize);
          await conn.request("guest-file-write", {
            handle: opened.handle,
            "buf-b64": chunk.toString("base64"),
          });
        }
      } catch (error) {
        primaryError = error;
      }
      try {
        await conn.request("guest-file-close", { handle: opened.handle });
      } catch (closeError) {
        if (primaryError === undefined) {
          throw closeError;
        }
      }
      if (primaryError !== undefined) {
        if (primaryError instanceof Error) {
          throw primaryError;
        }
        throw new CrucibleError(
          "PROCESS_FAILED",
          `writeFile failed with non-Error value`,
          primaryError,
        );
      }
    });
  }

  async #withConnection<T>(label: string, op: (conn: QgaConnection) => Promise<T>): Promise<T> {
    const socket = await connectSocket(this.#socketPath, this.#timeoutMs);
    const conn = new QgaConnection(socket, this.#timeoutMs);
    try {
      return await op(conn);
    } finally {
      conn.dispose();
    }
  }

  async #withRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.#retryPolicy.budgetMs;
    let backoff = this.#retryPolicy.initialBackoffMs;
    let lastError: unknown;
    while (true) {
      this.#throwIfAborted(label);
      try {
        return await op();
      } catch (error) {
        if (!isTransientQgaError(error)) {
          throw error;
        }
        lastError = error;
        if (Date.now() >= deadline) {
          break;
        }
        await this.#sleepRespectingAbort(Math.min(backoff, this.#retryPolicy.maxBackoffMs), label);
        backoff = Math.min(backoff * 2, this.#retryPolicy.maxBackoffMs);
      }
    }
    throw new CrucibleError(
      "PROCESS_TIMEOUT",
      `QGA ${label} retry budget exhausted (${this.#retryPolicy.budgetMs}ms); last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
    );
  }

  #throwIfAborted(label: string): void {
    if (this.#signal?.aborted === true) {
      throw new CrucibleError(
        "PROCESS_FAILED",
        `QGA ${label} aborted: ${describeAbortReason(this.#signal.reason)}`,
        this.#signal.reason,
      );
    }
  }

  async #sleepRespectingAbort(ms: number, label: string): Promise<void> {
    if (this.#signal === undefined) {
      await this.#sleep(ms);
      return;
    }
    if (this.#signal.aborted) {
      this.#throwIfAborted(label);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          new CrucibleError(
            "PROCESS_FAILED",
            `QGA ${label} aborted: ${describeAbortReason(this.#signal!.reason)}`,
            this.#signal!.reason,
          ),
        );
      };
      const timer = setTimeout(() => {
        this.#signal!.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      this.#signal!.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * A single open AF_UNIX connection to qemu-ga that can run multiple
 * sequential RPCs. Critical for any stateful interaction (file handles,
 * `guest-exec` pids) because qemu-ga on Windows has a process-global
 * handle table with NO per-client cleanup on disconnect — closing the
 * socket between guest-file-open and guest-file-close leaks the handle
 * forever in qga.exe and every subsequent open for the same path
 * collides with ERROR_SHARING_VIOLATION against qemu-ga's own handle.
 */
class QgaConnection {
  readonly #socket: Socket;
  readonly #timeoutMs: number;
  #buffer = "";
  #pending:
    | { resolve: (line: string) => void; reject: (err: unknown) => void; timer: NodeJS.Timeout }
    | undefined;
  #closedError: Error | undefined;
  #disposed = false;

  constructor(socket: Socket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", (error) => this.#onTransportFailure(error, "QGA socket error"));
    socket.on("close", () => this.#onTransportFailure(undefined, "QGA socket closed"));
  }

  async request<T>(command: string, args: Record<string, unknown>): Promise<T> {
    if (this.#disposed) {
      throw new CrucibleError("PROCESS_FAILED", `QGA connection disposed before ${command}`);
    }
    if (this.#closedError !== undefined) {
      throw this.#closedError;
    }
    this.#socket.write(`${JSON.stringify({ execute: command, arguments: args })}\r\n`);
    const line = await this.#nextLine(command);
    let response: QgaResponse<T>;
    try {
      response = JSON.parse(line) as QgaResponse<T>;
    } catch (parseError) {
      throw new CrucibleError("QMP_PARSE_ERROR", "Unable to parse QGA response", parseError);
    }
    if (response.error !== undefined) {
      const desc = response.error.desc ?? "(no desc)";
      const className = response.error.class ?? "GenericError";
      throw new CrucibleError(
        "PROCESS_FAILED",
        `QGA command failed: ${command} — ${className}: ${desc}`,
        response.error,
      );
    }
    return response.return as T;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    // destroy(), not end(): end() leaves the libuv handle in FIN_WAIT and
    // wedges the event loop if the peer never closes.
    this.#socket.destroy();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1 || this.#pending === undefined) {
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      const pending = this.#pending;
      this.#pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(line);
    }
  }

  #onTransportFailure(originalError: unknown, message: string): void {
    if (this.#closedError !== undefined || this.#disposed) {
      return;
    }
    this.#closedError = new CrucibleError("PROCESS_FAILED", message, originalError);
    if (this.#pending !== undefined) {
      const pending = this.#pending;
      this.#pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(this.#closedError);
    }
  }

  #nextLine(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.#closedError !== undefined) {
        reject(this.#closedError);
        return;
      }
      const timer = setTimeout(() => {
        if (this.#pending !== undefined && this.#pending.timer === timer) {
          this.#pending = undefined;
        }
        reject(
          new CrucibleError(
            "PROCESS_TIMEOUT",
            `Timed out waiting for QGA response (${command}, ${this.#timeoutMs}ms)`,
          ),
        );
      }, this.#timeoutMs);
      this.#pending = { resolve, reject, timer };
    });
  }
}

/**
 * Classify a QGA error as transient (retryable) vs permanent. Transient:
 *  - Socket-level timeouts (PROCESS_TIMEOUT) — agent didn't respond in
 *    time, often because Windows is mid-reboot.
 *  - Socket-level connect failures — agent service is restarting.
 *  - Structured QGA errors that look like "lost handle/pid" — usually
 *    after qemu-ga itself was restarted by a Windows reboot, which
 *    invalidates all open file handles and running exec pids.
 */
function isTransientQgaError(error: unknown): boolean {
  if (!(error instanceof CrucibleError)) {
    return false;
  }
  if (error.code === "PROCESS_TIMEOUT") {
    return true;
  }
  if (error.code !== "PROCESS_FAILED") {
    return false;
  }
  if (error.message.startsWith("Unable to connect to QGA")) {
    return true;
  }
  if (error.message === "QGA socket error" || error.message === "QGA socket closed") {
    // Mid-flight socket failure (ECONNRESET / EPIPE / peer-closed) —
    // qemu-ga went away while we held an open connection. Exactly what
    // a guest reboot looks like from the host side.
    return true;
  }
  const desc = (error.details as { desc?: string } | undefined)?.desc ?? "";
  if (
    error.message.startsWith("QGA command failed: guest-exec-status") ||
    error.message.startsWith("QGA command failed: guest-file-write") ||
    error.message.startsWith("QGA command failed: guest-file-close")
  ) {
    return /pid|handle|not found|invalid/i.test(desc);
  }
  if (error.message.startsWith("QGA command failed: guest-file-open")) {
    // Windows ERROR_SHARING_VIOLATION (32 / 0x80070020). Defender's
    // filesystem minifilter and similar on-access scanners briefly open
    // newly-created script files with FILE_SHARE_READ only, racing
    // qemu-ga's GENERIC_WRITE open. The lock typically clears within
    // 100-1500ms, so retrying with exponential backoff works. qemu-ga
    // surfaces the localized OS message; we match the en-US form
    // explicitly (the autounattend ISO sets en-US, so this is the
    // form we'll see in practice).
    return /being used by another process|sharing violation|cannot access the file/i.test(desc);
  }
  return false;
}

export type QgaProvisioningExecutorOptions = {
  readonly client: QgaClient;
  readonly vmName: string;
  readonly secretsDirectory: string;
  readonly timeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly readinessPollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Map of host-side stage IDs → list of (hostPath, guestPath) pairs to
   * upload before that stage's PowerShell script runs. Lets the CLI stage
   * mTLS material + the agent binary before `install-guest-agent` fires,
   * without bundling them into the autounattend ISO. Keyed by the
   * concrete `ProvisioningStageId` union so a misspelled stage id is a
   * compile error instead of a silent no-op.
   */
  readonly filesToStage?: Partial<Record<ProvisioningStageId, readonly StagedFile[]>>;
};

export type StagedFile = {
  readonly hostPath: string;
  readonly guestPath: string;
};

export class QgaProvisioningExecutor implements ProvisioningExecutor {
  readonly #client: QgaClient;
  readonly #vmName: string;
  readonly #secretsDirectory: string;
  readonly #timeoutMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #readinessPollIntervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #filesToStage: Partial<Record<ProvisioningStageId, readonly StagedFile[]>>;

  constructor(options: QgaProvisioningExecutorOptions) {
    this.#client = options.client;
    this.#vmName = options.vmName;
    this.#secretsDirectory = options.secretsDirectory;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_QGA_READINESS_TIMEOUT_MS;
    this.#readinessPollIntervalMs =
      options.readinessPollIntervalMs ?? QGA_READINESS_POLL_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#filesToStage = options.filesToStage ?? {};
  }

  async runStage(stage: ProvisioningStageContract) {
    // Upload any files registered for this stage before the script runs.
    // Used by the CLI to push mTLS material + the agent binary into the
    // guest immediately before install-guest-agent fires, so the script
    // sees them in place.
    const staged = this.#filesToStage[stage.id];
    if (staged !== undefined && staged.length > 0) {
      for (const file of staged) {
        try {
          await this.#stageFile(file);
        } catch (error) {
          throw new CrucibleError(
            "PROCESS_FAILED",
            `Failed to stage file for stage '${stage.id}': ${file.hostPath} -> ${file.guestPath}: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
      }
    }

    if (stage.id === "media-ready" || stage.id === "vm-booted") {
      return {
        id: stage.id,
        title: stage.title,
        status: "succeeded" as const,
        detail: "host-side stage satisfied before QGA execution",
      };
    }

    if (stage.id === "qga-ready") {
      await this.#waitForGuestReadiness();
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
    const args = await this.#stageScriptArgs(stage);
    const result = await this.#client.exec(stage.script.executable, args, {
      timeoutMs: Math.max(stage.script.timeoutMs, this.#timeoutMs),
      env,
      // Provisioning PowerShell scripts in guest/provision/ are written to be
      // idempotent (they short-circuit when already-applied) so the exec can
      // safely be replayed if a Windows reboot during the stage drops
      // qemu-ga's pid.
      idempotent: true,
    });

    return {
      id: stage.id,
      title: stage.title,
      status:
        // exit 75 (EX_TEMPFAIL) is reserved for opt-in skip paths (e.g. WinDbg
        // installer unreachable on an isolated network). Treat it as success
        // so downstream stages still run; the underlying stdout JSON carries
        // the skip reason for the operator.
        result.exitCode === 0 || result.exitCode === 75
          ? !result.timedOut
            ? ("succeeded" as const)
            : ("blocked" as const)
          : ("blocked" as const),
      detail: result.timedOut
        ? "QGA guest-exec timed out"
        : result.exitCode === 0
          ? stage.script.scriptPath
          : result.exitCode === 75
            ? `${stage.script.scriptPath} (skipped)`
            : result.stderr || `guest-exec exit code ${result.exitCode ?? "unknown"}`,
    };
  }

  async #stageFile(file: StagedFile): Promise<void> {
    const contents = await readFile(file.hostPath);
    await this.#ensureGuestDirectory(guestParentDir(file.guestPath));
    await this.#client.writeFile(file.guestPath, contents);
  }

  async #ensureGuestDirectory(guestPath: string): Promise<void> {
    if (guestPath === "") {
      return;
    }
    // qemu-ga's guest-file-open does not create missing parent directories.
    // PowerShell's New-Item -Force is idempotent (no error if the path
    // already exists) and creates intermediate directories. Prefer it over
    // cmd.exe `mkdir` because qemu-ga's spawn of cmd.exe has been flaky
    // during the install/postinstall window (#119, #122 follow-up).
    const psCommand = `$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path '${guestPath.replaceAll("'", "''")}' | Out-Null`;
    const result = await this.#client.exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCommand],
      { timeoutMs: this.#timeoutMs, idempotent: true },
    );
    if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== undefined)) {
      throw new CrucibleError(
        "PROCESS_FAILED",
        `Failed to mkdir guest directory ${guestPath}: exit=${result.exitCode ?? "none"} timedOut=${result.timedOut} stderr=${(result.stderr ?? "").slice(0, 500)}`,
        { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout },
      );
    }
  }

  async #waitForGuestReadiness(): Promise<void> {
    const deadline = this.#now() + this.#readinessTimeoutMs;
    let lastError: unknown;
    while (this.#now() < deadline) {
      try {
        await this.#client.ping();
        return;
      } catch (error) {
        lastError = error;
      }
      await this.#sleep(this.#readinessPollIntervalMs);
    }
    throw new CrucibleError(
      "QMP_TIMEOUT",
      `Timed out waiting for QGA after ${this.#readinessTimeoutMs}ms`,
      lastError,
    );
  }

  async #stageScriptArgs(stage: ProvisioningStageContract): Promise<readonly string[]> {
    if (stage.script === undefined) {
      throw new CrucibleError("STATE_INVALID", `stage ${stage.id} has no script`);
    }
    const scriptBody = await readFile(stage.script.scriptPath, "utf8");
    const guestPath = `C:\\ProgramData\\Crucible\\stages\\${path.basename(stage.script.scriptPath)}`;
    try {
      await this.#ensureGuestDirectory(guestParentDir(guestPath));
      await this.#client.writeFile(guestPath, scriptBody);
    } catch (error) {
      throw new CrucibleError(
        "PROCESS_FAILED",
        `Failed to stage script for stage '${stage.id}': ${stage.script.scriptPath} -> ${guestPath}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    // The contract stores the full PowerShell invocation
    // (`-NoProfile -ExecutionPolicy Bypass -File <host-path> [...userArgs]`)
    // so the host-side runner can spawn powershell.exe directly. The
    // QGA-backed runner re-builds that prefix around the guest-staged
    // copy, so peel off everything up to and including
    // `-File <host-path>` and keep only the trailing user arguments.
    const contractArgs = stage.script.arguments ?? [];
    const fileFlagIndex = contractArgs.indexOf("-File");
    const trailingArgs = fileFlagIndex >= 0 ? contractArgs.slice(fileFlagIndex + 2) : contractArgs;
    return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", guestPath, ...trailingArgs];
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

function decodeBase64(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function describeAbortReason(reason: unknown): string {
  if (reason === undefined || reason === null) {
    return "signal aborted";
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return "signal aborted";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function guestParentDir(guestPath: string): string {
  const idx = guestPath.lastIndexOf("\\");
  return idx <= 0 ? "" : guestPath.slice(0, idx);
}
