// Package-level constants for debugger automation. These wrap cdb.exe so
// the host can drive triage from MCP tools without persisting interactive
// state in the guest. Each session is uniquely identified host-side; the
// guest runs cdb.exe -c "<commands>; q" per invocation and the host
// accumulates the transcript.

export type DebuggerSessionMode = "launch" | "attach";
export type DebuggerArchitecture = "x86" | "x64";

export type DebuggerSessionSpec =
  | {
      readonly mode: "launch";
      readonly executable: string;
      readonly arguments?: readonly string[];
      readonly symbolPath?: string;
      readonly arch?: DebuggerArchitecture;
    }
  | {
      readonly mode: "attach";
      readonly pid: number;
      readonly symbolPath?: string;
      readonly arch?: DebuggerArchitecture;
    };

export type DebuggerCommandResult = {
  readonly command: string;
  readonly cdbArgs: readonly string[];
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
};

export type DebuggerSession = {
  readonly id: string;
  readonly spec: DebuggerSessionSpec;
  readonly cdbExecutable: string;
  readonly createdAt: string;
  readonly transcript: DebuggerCommandResult[];
};

export type DebuggerExecutableResolver = (arch: DebuggerArchitecture) => string;

export type DebuggerDumpRequest = {
  readonly outputGuestPath: string;
  readonly minidump?: boolean;
};

const DEFAULT_CDB_EXECUTABLE = "C:\\Program Files\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe";
const MAX_COMMAND_LENGTH = 4 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 200;

export type DebuggerSessionManagerOptions = {
  /**
   * The function used to run a debugger invocation on the guest. In
   * production the MCP tool wires this to GuestAgentClient.exec, in tests
   * the unit suite injects a fake.
   */
  readonly run: (cdbArgs: readonly string[], cdbExecutable: string) => Promise<RunResult>;
  readonly cdbExecutable?: string;
  readonly cdbExecutableForArch?: DebuggerExecutableResolver;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
};

export type RunResult = {
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
};

export class DebuggerSessionManager {
  readonly #run: DebuggerSessionManagerOptions["run"];
  readonly #cdb: string;
  readonly #cdbForArch: DebuggerExecutableResolver;
  readonly #idFactory: () => string;
  readonly #now: () => Date;
  readonly #sessions = new Map<string, DebuggerSession>();

  constructor(options: DebuggerSessionManagerOptions) {
    this.#run = options.run;
    this.#cdb = options.cdbExecutable ?? DEFAULT_CDB_EXECUTABLE;
    this.#cdbForArch = options.cdbExecutableForArch ?? (() => this.#cdb);
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#now = options.now ?? (() => new Date());
  }

  /** Start a new session. cdb is *not* invoked; the next command() will. */
  open(spec: DebuggerSessionSpec): DebuggerSession {
    const id = this.#idFactory();
    const session: DebuggerSession = {
      id,
      spec,
      cdbExecutable: spec.arch === undefined ? this.#cdb : this.#cdbForArch(spec.arch),
      createdAt: this.#now().toISOString(),
      transcript: [],
    };
    this.#sessions.set(id, session);
    return session;
  }

  list(): readonly DebuggerSession[] {
    return Array.from(this.#sessions.values());
  }

  get(id: string): DebuggerSession {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      throw new Error(`debugger session ${id} not found`);
    }
    return session;
  }

  close(id: string): void {
    this.#sessions.delete(id);
  }

  /**
   * Execute a single cdb command sequence inside the session's target.
   * Commands are concatenated with ';' and terminated with 'q' so cdb
   * exits after running them.
   */
  async command(id: string, commands: readonly string[]): Promise<DebuggerCommandResult> {
    if (commands.length === 0) {
      throw new Error("at least one command is required");
    }
    const joined = commands.join("; ");
    if (joined.length > MAX_COMMAND_LENGTH) {
      throw new Error(`command sequence exceeds ${MAX_COMMAND_LENGTH} bytes`);
    }
    const session = this.get(id);
    const args = this.#buildCdbArgs(session.spec, `${joined}; q`);
    const result = await this.#run(args, session.cdbExecutable);
    const recorded: DebuggerCommandResult = {
      command: joined,
      cdbArgs: args,
      stdoutBase64: result.stdoutBase64,
      stderrBase64: result.stderrBase64,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
    };
    appendTranscript(session, recorded);
    return recorded;
  }

  /**
   * Collect a memory dump for the target. Uses `.dump /ma <path>` (full
   * user-mode dump) by default; pass `minidump: true` for a smaller
   * triage dump.
   */
  async dump(id: string, request: DebuggerDumpRequest): Promise<DebuggerCommandResult> {
    const flag = request.minidump ? "" : "/ma ";
    return this.command(id, [`.dump ${flag}${request.outputGuestPath}`]);
  }

  #buildCdbArgs(spec: DebuggerSessionSpec, commandSequence: string): readonly string[] {
    const args: string[] = ["-c", commandSequence];
    if (spec.symbolPath !== undefined && spec.symbolPath !== "") {
      args.push("-y", spec.symbolPath);
    }
    if (spec.mode === "launch") {
      args.push(spec.executable, ...(spec.arguments ?? []));
    } else {
      args.push("-p", String(spec.pid));
    }
    return args;
  }
}

function appendTranscript(session: DebuggerSession, entry: DebuggerCommandResult): void {
  // Mutate the transcript array directly. The public type marks the
  // property as `readonly` to discourage reassignment, but the inner array
  // is intentionally mutable so the manager can append + cap entries.
  session.transcript.push(entry);
  while (session.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
    session.transcript.shift();
  }
}

function defaultIdFactory(): string {
  return `dbg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
