export type CrucibleErrorCode =
  | "CONFIG_INVALID"
  | "HOST_PREREQUISITE_MISSING"
  | "PROCESS_TIMEOUT"
  | "PROCESS_FAILED"
  | "MEDIA_UNAVAILABLE"
  | "STATE_INVALID";

export class CrucibleError extends Error {
  constructor(
    readonly code: CrucibleErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CrucibleError";
  }
}
