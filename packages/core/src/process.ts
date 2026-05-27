export type ProcessFailureMode = "nonZeroExit" | "timeout" | "signal" | "spawnError";

export type ProcessCommand = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdin?: string;
  readonly maxOutputBytes?: number;
};

export type ProcessResult = {
  readonly command: ProcessCommand;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
};

export type ProcessRunner = {
  readonly run: (command: ProcessCommand) => Promise<ProcessResult>;
};

export function describeCommand(command: ProcessCommand): string {
  return [command.executable, ...command.args].join(" ");
}
