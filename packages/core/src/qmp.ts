import net from "node:net";

import { CrucibleError } from "./errors.js";

export const DEFAULT_QMP_TIMEOUT_MS = 5000;
export const DEFAULT_QMP_MAX_BUFFER_BYTES = 1024 * 1024;

export type QmpRequestId = string | number;

export type QmpClientOptions = {
  readonly socketPath: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
};

export type QmpGreeting = {
  readonly version: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly string[];
};

export type QmpEvent = {
  readonly event: string;
  readonly data?: unknown;
  readonly timestamp?: unknown;
};

export type QmpCommandOptions = {
  readonly id?: QmpRequestId;
  readonly timeoutMs?: number;
};

export type QmpCommandResult<T = unknown> = {
  readonly id: QmpRequestId;
  readonly returnValue: T;
  readonly events: readonly QmpEvent[];
};

type PendingCommand = {
  readonly id: QmpRequestId;
  readonly eventStart: number;
  readonly resolve: (message: SettledQmpReturnMessage) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: NodeJS.Timeout;
};

type QmpReturnMessage = {
  readonly returnValue: unknown;
  readonly id?: QmpRequestId;
};

type SettledQmpReturnMessage = QmpReturnMessage & {
  readonly events: readonly QmpEvent[];
};

type QmpErrorMessage = {
  readonly error: {
    readonly class: string;
    readonly desc: string;
  };
  readonly id?: QmpRequestId;
};

export type ParsedQmpMessage =
  | { readonly kind: "greeting"; readonly greeting: QmpGreeting }
  | { readonly kind: "event"; readonly event: QmpEvent }
  | { readonly kind: "return"; readonly response: QmpReturnMessage }
  | { readonly kind: "error"; readonly response: QmpErrorMessage };

export class QmpClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #maxBufferBytes: number;
  #socket: net.Socket;
  #buffer = "";
  #connected = false;
  #connecting = false;
  #suppressNextClose = false;
  #ready = false;
  #nextId = 1;
  #greeting: QmpGreeting | undefined;
  #readyPromise: Promise<QmpGreeting> | undefined;
  #greetingPromise: Promise<QmpGreeting> | undefined;
  #terminalError: CrucibleError | undefined;
  #greetingWaiter:
    | {
        readonly resolve: (greeting: QmpGreeting) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;
  readonly #pending = new Map<QmpRequestId, PendingCommand>();
  readonly #usedCallerIds = new Set<QmpRequestId>();
  readonly #events: QmpEvent[] = [];
  #commandQueue = Promise.resolve();

  constructor(options: QmpClientOptions) {
    this.#socketPath = options.socketPath;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QMP_TIMEOUT_MS;
    this.#maxBufferBytes = options.maxBufferBytes ?? DEFAULT_QMP_MAX_BUFFER_BYTES;
    this.#socket = this.#createSocket();
  }

  #createSocket(): net.Socket {
    const socket = new net.Socket();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#handleData(chunk));
    socket.on("error", (error) => {
      if (this.#connecting) {
        return;
      }
      this.#disconnectPermanently(
        qmpError("QMP_DISCONNECTED", "QMP socket error", {
          cause: error.message,
          code: "code" in error ? error.code : undefined,
        }),
      );
    });
    socket.on("close", () => {
      if (this.#suppressNextClose) {
        this.#suppressNextClose = false;
        return;
      }
      if (this.#connecting) {
        return;
      }
      this.#disconnectPermanently(qmpError("QMP_DISCONNECTED", "QMP socket closed"));
    });
    return socket;
  }

  get greeting(): QmpGreeting | undefined {
    return this.#greeting;
  }

  async connect(): Promise<QmpGreeting> {
    if (this.#ready && this.#greeting !== undefined) {
      return this.#greeting;
    }

    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }

    this.#readyPromise ??= this.#connectAndNegotiate();
    return this.#readyPromise;
  }

  async execute<T = unknown>(
    command: string,
    args?: Readonly<Record<string, unknown>>,
    options: QmpCommandOptions = {},
  ): Promise<QmpCommandResult<T>> {
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }

    if (!this.#ready) {
      if (this.#readyPromise === undefined) {
        throw qmpError("QMP_DISCONNECTED", "QMP socket is not ready");
      }
      await this.#readyPromise;
    }

    return this.#executeCommand<T>(command, args, options);
  }

  async #connectAndNegotiate(): Promise<QmpGreeting> {
    try {
      await this.#connectSocket();
      const greeting = await this.#waitForGreeting(this.#timeoutMs);
      await this.#executeCommand("qmp_capabilities", undefined, { timeoutMs: this.#timeoutMs });
      this.#ready = true;
      return greeting;
    } catch (error) {
      this.#ready = false;
      if (this.#terminalError === undefined) {
        this.#readyPromise = undefined;
      }
      throw error;
    }
  }

  async #executeCommand<T = unknown>(
    command: string,
    args: Readonly<Record<string, unknown>> | undefined,
    options: QmpCommandOptions,
  ): Promise<QmpCommandResult<T>> {
    const run = this.#commandQueue.then(() => this.#executeNow<T>(command, args, options));
    this.#commandQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #executeNow<T = unknown>(
    command: string,
    args: Readonly<Record<string, unknown>> | undefined,
    options: QmpCommandOptions,
  ): Promise<QmpCommandResult<T>> {
    if (!this.#connected) {
      throw qmpError("QMP_DISCONNECTED", "QMP socket is not connected");
    }

    const callerSuppliedId = options.id !== undefined;
    const id = options.id ?? this.#nextRequestId();
    if (this.#pending.has(id) || this.#usedCallerIds.has(id)) {
      throw qmpError("QMP_PROTOCOL_ERROR", `duplicate QMP request id: ${String(id)}`, { id });
    }
    if (callerSuppliedId) {
      this.#usedCallerIds.add(id);
    }

    const request =
      args === undefined ? { execute: command, id } : { execute: command, arguments: args, id };
    const eventStart = this.#events.length;

    const response = await new Promise<SettledQmpReturnMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          qmpError("QMP_TIMEOUT", `QMP command timed out after ${this.#timeoutFor(options)} ms`, {
            command,
            id,
          }),
        );
      }, this.#timeoutFor(options));

      this.#pending.set(id, { id, eventStart, resolve, reject, timeout });
      this.#socket.write(`${JSON.stringify(request)}\r\n`);
    });

    return {
      id,
      returnValue: response.returnValue as T,
      events: response.events,
    };
  }

  drainEvents(): readonly QmpEvent[] {
    if (this.#pending.size > 0) {
      throw qmpError("QMP_PROTOCOL_ERROR", "cannot drain QMP events while commands are pending");
    }
    return this.#events.splice(0, this.#events.length);
  }

  close(): void {
    const error = qmpError("QMP_DISCONNECTED", "QMP client closed");
    this.#terminalError = error;
    this.#connected = false;
    this.#ready = false;
    this.#greeting = undefined;
    this.#usedCallerIds.clear();
    this.#failAll(error);
    this.#socket.destroy();
  }

  async #connectSocket(): Promise<void> {
    if (this.#connected) {
      return;
    }

    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }

    if (this.#socket.destroyed) {
      this.#socket = this.#createSocket();
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      this.#connecting = true;
      const timeout = setTimeout(() => {
        const error = qmpError(
          "QMP_TIMEOUT",
          `QMP socket connect timed out after ${this.#timeoutMs} ms`,
          {
            socketPath: this.#socketPath,
          },
        );
        settled = true;
        cleanup();
        this.#destroyForRetry(error);
        reject(error);
      }, this.#timeoutMs);

      const onConnect = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.#connected = true;
        resolve();
      };
      const onError = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.#suppressNextClose = true;
        cleanup();
        this.#socket.destroy();
        reject(
          qmpError("QMP_CONNECTION_FAILED", `failed to connect QMP socket ${this.#socketPath}`, {
            cause: error.message,
            code: "code" in error ? error.code : undefined,
          }),
        );
      };
      const onClose = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(qmpError("QMP_DISCONNECTED", "QMP socket closed before connecting"));
      };
      const cleanup = (): void => {
        this.#connecting = false;
        clearTimeout(timeout);
        this.#socket.off("connect", onConnect);
        this.#socket.off("error", onError);
        this.#socket.off("close", onClose);
      };

      this.#socket.once("connect", onConnect);
      this.#socket.once("error", onError);
      this.#socket.once("close", onClose);
      this.#socket.connect(this.#socketPath);
    });
  }

  async #waitForGreeting(timeoutMs: number): Promise<QmpGreeting> {
    if (this.#greeting !== undefined) {
      return this.#greeting;
    }

    this.#greetingPromise ??= new Promise<QmpGreeting>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = qmpError("QMP_TIMEOUT", `QMP greeting timed out after ${timeoutMs} ms`, {
          socketPath: this.#socketPath,
        });
        this.#greetingWaiter = undefined;
        this.#greetingPromise = undefined;
        this.#destroyForRetry(error);
        reject(error);
      }, timeoutMs);

      this.#greetingWaiter = {
        resolve: (greeting) => {
          clearTimeout(timeout);
          this.#greetingPromise = undefined;
          resolve(greeting);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.#greetingPromise = undefined;
          reject(
            error instanceof Error
              ? error
              : qmpError("QMP_PROTOCOL_ERROR", "QMP greeting failed with a non-error rejection", {
                  error,
                }),
          );
        },
      };
    });
    return this.#greetingPromise;
  }

  #handleData(chunk: string | Buffer): void {
    this.#buffer += chunk.toString();
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxBufferBytes) {
      this.#terminateForProtocolError(
        qmpError("QMP_PARSE_ERROR", "QMP message exceeded maximum buffer size", {
          maxBufferBytes: this.#maxBufferBytes,
        }),
      );
      return;
    }

    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) {
        this.#handleLine(line);
      }
    }
  }

  #handleLine(line: string): void {
    let message: ParsedQmpMessage;
    try {
      message = parseQmpMessage(line);
    } catch (error) {
      this.#terminateForProtocolError(error);
      return;
    }

    try {
      switch (message.kind) {
        case "greeting":
          this.#greeting = message.greeting;
          this.#greetingWaiter?.resolve(message.greeting);
          this.#greetingWaiter = undefined;
          break;
        case "event":
          this.#events.push(message.event);
          break;
        case "return":
          this.#settlePendingReturn(message.response);
          break;
        case "error":
          this.#settlePendingError(
            message.response.id,
            qmpError("QMP_COMMAND_FAILED", message.response.error.desc, {
              qmpClass: message.response.error.class,
            }),
          );
          break;
      }
    } catch (error) {
      this.#terminateForProtocolError(error);
    }
  }

  #settlePendingReturn(response: QmpReturnMessage): void {
    const pending = this.#takePending(response.id);
    pending.resolve({ ...response, events: this.#takePendingEvents(pending) });
  }

  #settlePendingError(id: QmpRequestId | undefined, error: unknown): void {
    const pending = this.#takePending(id);
    this.#takePendingEvents(pending);
    pending.reject(error);
  }

  #takePending(id: QmpRequestId | undefined): PendingCommand {
    if (id === undefined) {
      this.#failAll(qmpError("QMP_PROTOCOL_ERROR", "QMP response omitted request id"));
      throw qmpError("QMP_PROTOCOL_ERROR", "QMP response omitted request id");
    }

    const pending = this.#pending.get(id);
    if (pending === undefined) {
      throw qmpError("QMP_PROTOCOL_ERROR", `QMP response used unknown request id: ${String(id)}`, {
        id,
      });
    }

    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    return pending;
  }

  #takePendingEvents(pending: PendingCommand): readonly QmpEvent[] {
    return this.#events.splice(pending.eventStart, this.#events.length - pending.eventStart);
  }

  #failAll(error: unknown): void {
    this.#greetingWaiter?.reject(error);
    this.#greetingWaiter = undefined;
    this.#greetingPromise = undefined;
    this.#readyPromise = undefined;

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #disconnectPermanently(error: CrucibleError): void {
    if (this.#terminalError === undefined) {
      this.#terminalError = error;
    }
    this.#connected = false;
    this.#ready = false;
    this.#greeting = undefined;
    this.#usedCallerIds.clear();
    this.#failAll(error);
  }

  #terminateForProtocolError(error: unknown): void {
    const terminalError =
      error instanceof CrucibleError
        ? error
        : qmpError("QMP_PROTOCOL_ERROR", "QMP protocol handling failed", { error });
    this.#terminalError = terminalError;
    this.#connected = false;
    this.#ready = false;
    this.#greeting = undefined;
    this.#usedCallerIds.clear();
    this.#failAll(terminalError);
    this.#socket.destroy();
  }

  #destroyForRetry(error: CrucibleError): void {
    this.#connected = false;
    this.#ready = false;
    this.#greeting = undefined;
    this.#usedCallerIds.clear();
    this.#failAll(error);
    this.#suppressNextClose = true;
    this.#socket.destroy();
  }

  #nextRequestId(): QmpRequestId {
    const id = `crucible-${this.#nextId}`;
    this.#nextId += 1;
    return id;
  }

  #timeoutFor(options: QmpCommandOptions): number {
    return options.timeoutMs ?? this.#timeoutMs;
  }
}

export function parseQmpMessage(line: string): ParsedQmpMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw qmpError("QMP_PARSE_ERROR", "QMP sent invalid JSON", {
      line,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!isRecord(value)) {
    throw qmpError("QMP_PARSE_ERROR", "QMP message must be a JSON object", { value });
  }

  if (hasExactKeys(value, ["QMP"])) {
    return { kind: "greeting", greeting: parseGreeting(value.QMP) };
  }

  if (hasOnlyKeys(value, ["event", "data", "timestamp"]) && typeof value.event === "string") {
    return {
      kind: "event",
      event: { event: value.event, data: value.data, timestamp: value.timestamp },
    };
  }

  if (hasOnlyKeys(value, ["return", "id"]) && "return" in value) {
    return {
      kind: "return",
      response: { returnValue: value.return, id: parseRequestId(value.id) },
    };
  }

  if (hasOnlyKeys(value, ["error", "id"]) && "error" in value) {
    return {
      kind: "error",
      response: { error: parseError(value.error), id: parseRequestId(value.id) },
    };
  }

  throw qmpError("QMP_PARSE_ERROR", "QMP message has unsupported or unknown top-level fields", {
    keys: Object.keys(value),
  });
}

function parseGreeting(value: unknown): QmpGreeting {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "capabilities"])) {
    throw qmpError("QMP_PARSE_ERROR", "QMP greeting has unsupported fields", { value });
  }

  if (!isRecord(value.version)) {
    throw qmpError("QMP_PARSE_ERROR", "QMP greeting version must be an object", { value });
  }

  if (
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((capability) => typeof capability === "string")
  ) {
    throw qmpError("QMP_PARSE_ERROR", "QMP greeting capabilities must be strings", { value });
  }

  return {
    version: value.version,
    capabilities: value.capabilities,
  };
}

function parseError(value: unknown): QmpErrorMessage["error"] {
  if (!isRecord(value) || !hasExactKeys(value, ["class", "desc"])) {
    throw qmpError("QMP_PARSE_ERROR", "QMP error must include only class and desc", { value });
  }

  if (typeof value.class !== "string" || typeof value.desc !== "string") {
    throw qmpError("QMP_PARSE_ERROR", "QMP error class and desc must be strings", { value });
  }

  return { class: value.class, desc: value.desc };
}

function parseRequestId(value: unknown): QmpRequestId | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" || typeof value === "number") {
    return value;
  }

  throw qmpError("QMP_PARSE_ERROR", "QMP request id must be a string or number", { value });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return valueKeys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return valueKeys(value).every((key) => allowed.has(key));
}

function valueKeys(value: Record<string, unknown>): readonly string[] {
  return Object.keys(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function qmpError(code: QmpErrorCode, message: string, details?: unknown): CrucibleError {
  return new CrucibleError(code, message, details);
}

type QmpErrorCode = Extract<
  import("./errors.js").CrucibleErrorCode,
  | "QMP_CONNECTION_FAILED"
  | "QMP_TIMEOUT"
  | "QMP_PARSE_ERROR"
  | "QMP_PROTOCOL_ERROR"
  | "QMP_COMMAND_FAILED"
  | "QMP_DISCONNECTED"
>;
