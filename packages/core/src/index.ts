export {
  analysisVmPolicyConfigSchema,
  analysisVmPolicyProfileSchema,
  buildAnalysisVmPolicyReadiness,
  buildAnalysisVmPolicyScriptArguments,
  defaultAnalysisVmPolicyConfig,
  parseAnalysisVmPolicyAudit,
  parseAnalysisVmPolicyConfig,
} from "./analysis-policy.js";
export type {
  AnalysisVmPolicyAudit,
  AnalysisVmPolicyConfig,
  AnalysisVmPolicyConfigInput,
  AnalysisVmPolicyProfile,
  AnalysisVmPolicyReadiness,
} from "./analysis-policy.js";
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
  buildNetworkModeChangePlan,
  buildNetworkRuntimeStatus,
  buildNetworkTeardownOutputModel,
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
  NetworkModeChangePlan,
  NetworkOwnerTag,
  NetworkPlan,
  NetworkPlanOptions,
  NetworkRuntimeStatus,
  NetworkTeardownCommandPlan,
  NetworkTeardownOptions,
  NetworkTeardownOutputModel,
  NetworkTeardownPlan,
  NetworkTeardownRefusal,
  NetworkTeardownResource,
  QemuNetworkBackend,
  QemuNetworkPlan,
  QemuNetworkPortForward,
} from "./network.js";
export { createEmptyArtifactManifest, upsertArtifactRecord } from "./manifest.js";
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
export { QgaClient, QgaProvisioningExecutor } from "./qga.js";
export { GuestAgentClient } from "./guest-agent-client.js";
export type { GuestAgentFileInspection } from "./guest-agent-client.js";
export { runHostCheck } from "./host-check.js";
export type { HostCheckProbeResult } from "./host-check.js";
export { ensureMtlsBundle } from "./mtls.js";
export type { MtlsBundlePaths, EnsureMtlsBundleOptions } from "./mtls.js";
export { DebuggerSessionManager } from "./debugger.js";
export type {
  DebuggerSession,
  DebuggerSessionSpec,
  DebuggerSessionMode,
  DebuggerArchitecture,
  DebuggerCommandResult,
  DebuggerDumpRequest,
  DebuggerExecutableResolver,
  DebuggerSessionManagerOptions,
  RunResult,
} from "./debugger.js";
export { DEFAULT_POLICY, decideDownloadTarget, decideInternetEgress } from "./policy.js";
export type { CruciblePolicy, PolicyDecision } from "./policy.js";
export { runScenario } from "./scenario.js";
export type {
  ScenarioInput,
  ScenarioResult,
  ScenarioStep,
  ScenarioStepKind,
  ScenarioStepRecord,
  ScenarioRunnerOptions,
} from "./scenario.js";
export { aggregateAuditEvents } from "./audit.js";
export type { AuditEvent, AggregateAuditOptions } from "./audit.js";
export { rotateLocalAccountCredentials, rotateGuestServiceCertificatesPlan } from "./rotation.js";
export type { RotateCredentialsOptions, RotateCredentialsResult } from "./rotation.js";
export { exportArtifactBundle } from "./artifact-export.js";
export type {
  ArtifactDescriptor,
  ArtifactExportOptions,
  ArtifactExportResult,
} from "./artifact-export.js";
export type {
  GuestAgentClientOptions,
  GuestAgentHealth,
  GuestAgentExecRequest,
  GuestAgentExecResult,
  GuestAgentUploadResult,
} from "./guest-agent-client.js";
export type {
  QgaClientOptions,
  QgaGuestExecResult,
  QgaProvisioningExecutorOptions,
} from "./qga.js";
export {
  buildGuestAgentCertificateStagePlan,
  buildProvisioningPlan,
  buildProvisioningSecretStorageContract,
  buildGuestHealthReport,
  canAdvanceProvisioningStage,
  createInitialProvisioningStateMachine,
  PROVISIONING_SCRIPT_RUNNERS,
  PROVISIONING_SECRET_KINDS,
  PROVISIONING_STAGE_IDS,
  PROVISIONING_STAGE_TRANSITIONS,
  prepareRealFirstBootProvisioning,
  runProvisioningCommand,
  writeWindowsAccountSecrets,
} from "./provisioning.js";
export type {
  GuestHealthCheckResult,
  GuestHealthReport,
  GuestHealthStatus,
  GuestAgentCertificateStagePlan,
  ProvisioningCommandResult,
  ProvisioningCommandRunnerOptions,
  ProvisioningCommandStep,
  ProvisioningExecutor,
  ProvisioningPlan,
  ProvisioningPlanOptions,
  ProvisioningReadinessCheck,
  ProvisioningRunStatus,
  ProvisioningScriptInvocationContract,
  ProvisioningScriptResult,
  ProvisioningScriptRunner,
  ProvisioningSecretKind,
  ProvisioningSecretRef,
  ProvisioningSecretStorageContract,
  ProvisioningStageContract,
  ProvisioningStageId,
  ProvisioningStageState,
  ProvisioningStageStatus,
  ProvisioningStageTransition,
  ProvisioningStateMachine,
  RealFirstBootProvisioningOptions,
  RealFirstBootProvisioningPlan,
  WindowsAccountSecret,
  WindowsAccountSecretOptions,
  WindowsAccountSecretSummary,
  WindowsAccountSecretWriteResult,
  WindowsExecutionPrincipal,
} from "./provisioning.js";
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
export type {
  QemuBootMediaOptions,
  QemuBootMediaPlan,
  QemuCommandPlan,
  QemuDiskPlan,
  QemuPlanOptions,
  QemuSocketPlan,
} from "./qemu.js";
export { CLEAN_BASE_SNAPSHOT_NAME, normalizeSnapshotName, SnapshotManager } from "./snapshot.js";
export type {
  SnapshotCreateResult,
  SnapshotManagerOptions,
  SnapshotMode,
  SnapshotRestoreResult,
} from "./snapshot.js";

export const CRUCIBLE_VERSION = "0.1.0-beta.2";
