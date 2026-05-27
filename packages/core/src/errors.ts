export type CrucibleErrorCode =
  | "CONFIG_INVALID"
  | "HOST_PREREQUISITE_MISSING"
  | "PROCESS_TIMEOUT"
  | "PROCESS_FAILED"
  | "MEDIA_UNAVAILABLE"
  | "STATE_INVALID"
  | "QMP_CONNECTION_FAILED"
  | "QMP_TIMEOUT"
  | "QMP_PARSE_ERROR"
  | "QMP_PROTOCOL_ERROR"
  | "QMP_COMMAND_FAILED"
  | "QMP_DISCONNECTED";

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
