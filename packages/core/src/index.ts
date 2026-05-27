export { defaultCrucibleConfig, parseCrucibleConfig, crucibleConfigSchema } from "./config.js";
export type { CrucibleConfig, CrucibleConfigInput } from "./config.js";
export { CrucibleError } from "./errors.js";
export type { CrucibleErrorCode } from "./errors.js";
export {
  DEFAULT_MEDIA_CACHE_DIR,
  getManualDownloadInstructions,
  MANUAL_DOWNLOADS,
} from "./media.js";
export type {
  ManualDownload,
  MediaCacheConfig,
  MediaCacheEntry,
  MediaCachePlan,
  MediaKind,
  MediaOverride,
  MediaProfileName,
} from "./media.js";
export { createEmptyArtifactManifest } from "./manifest.js";
export type {
  ArtifactKind,
  ArtifactManifest,
  ArtifactRecord,
  CredentialRecord,
  SnapshotRecord,
} from "./manifest.js";
export { describeCommand } from "./process.js";
export type {
  ProcessCommand,
  ProcessFailureMode,
  ProcessResult,
  ProcessRunner,
} from "./process.js";

export const CRUCIBLE_VERSION = "0.0.0";
