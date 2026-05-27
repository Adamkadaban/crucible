export {
  defaultCrucibleConfig,
  loadCrucibleConfigFile,
  parseCrucibleConfig,
  crucibleConfigSchema,
} from "./config.js";
export type { CrucibleConfig, CrucibleConfigInput } from "./config.js";
export { CrucibleError } from "./errors.js";
export type { CrucibleErrorCode } from "./errors.js";
export { buildLifecyclePaths, VmLifecycleManager } from "./lifecycle.js";
export type {
  SpawnedVmProcess,
  VmCleanupResult,
  VmLifecycleManagerOptions,
  VmLifecyclePaths,
  VmLifecycleState,
  VmLifecycleStateManifest,
  VmProcessController,
  VmProcessSpawner,
  VmQmpClientFactory,
  VmQmpSession,
  VmRuntimeStatus,
  VmSpawnRequest,
  VmStartResult,
  VmStatus,
  VmStopMode,
  VmStopResult,
} from "./lifecycle.js";
export {
  buildMediaCachePlan,
  DEFAULT_MEDIA_CACHE_DIR,
  DEFAULT_MEDIA_SOURCES,
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
export {
  FIREWALL_BACKENDS,
  FIREWALL_OPERATION_MODES,
  buildNetworkPlan,
  NETWORK_MODES,
  networkConfigSchema,
  networkModeSchema,
  parseNetworkConfig,
} from "./network.js";
export type {
  ControlAddressAllocation,
  FirewallBackend,
  FirewallCommandPlan,
  FirewallOperationMode,
  FirewallPlan,
  FirewallRuleIntent,
  FirewallRulePlan,
  NetworkConfig,
  NetworkConfigInput,
  NetworkMode,
  NetworkOwnerTag,
  NetworkPlan,
  NetworkPlanOptions,
  NetworkTeardownPlan,
  QemuNetworkBackend,
  QemuNetworkPlan,
  QemuNetworkPortForward,
} from "./network.js";
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
export {
  DEFAULT_QMP_MAX_BUFFER_BYTES,
  DEFAULT_QMP_TIMEOUT_MS,
  parseQmpMessage,
  QmpClient,
} from "./qmp.js";
export type {
  QmpClientOptions,
  QmpCommandOptions,
  QmpCommandResult,
  QmpEvent,
  QmpGreeting,
  QmpRequestId,
} from "./qmp.js";
export { buildQemuCommandPlan, renderQemuCreateDryRun, renderQemuStartDryRun } from "./qemu.js";
export type { QemuCommandPlan, QemuDiskPlan, QemuPlanOptions, QemuSocketPlan } from "./qemu.js";

export const CRUCIBLE_VERSION = "0.0.0";
