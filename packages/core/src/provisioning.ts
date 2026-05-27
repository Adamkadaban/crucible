import path from "node:path";

export const PROVISIONING_STAGE_IDS = [
  "media-ready",
  "vm-booted",
  "qga-ready",
  "windbg-installed",
  "guest-agent-installed",
  "policy-configured",
  "local-accounts-created",
  "health-checked",
  "snapshot-prepared",
] as const;

export const PROVISIONING_SCRIPT_RUNNERS = [
  "host",
  "qga-powershell",
  "guest-agent-powershell",
] as const;

export const PROVISIONING_SECRET_KINDS = [
  "windows-standard-password",
  "windows-admin-password",
  "mtls-ca-private-key",
  "mtls-ca-certificate",
  "mtls-host-client-private-key",
  "mtls-host-client-certificate",
  "mtls-guest-server-private-key",
  "mtls-guest-server-certificate",
] as const;

export type ProvisioningStageId = (typeof PROVISIONING_STAGE_IDS)[number];
export type ProvisioningScriptRunner = (typeof PROVISIONING_SCRIPT_RUNNERS)[number];
export type ProvisioningSecretKind = (typeof PROVISIONING_SECRET_KINDS)[number];

export type ProvisioningStageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type ProvisioningRunStatus = "notStarted" | "running" | "blocked" | "complete";

export type ProvisioningReadinessCheck = {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
};

export type ProvisioningScriptInvocationContract = {
  readonly id: string;
  readonly runner: ProvisioningScriptRunner;
  readonly executable: string;
  readonly scriptPath: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly elevated: boolean;
  readonly redactedArgumentIndexes: readonly number[];
};

export type ProvisioningScriptResult = {
  readonly invocationId: string;
  readonly stageId: ProvisioningStageId;
  readonly status: "succeeded" | "failed" | "timedOut" | "skipped";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
};

export type ProvisioningSecretRef = {
  readonly kind: ProvisioningSecretKind;
  readonly id: string;
  readonly path: string;
  readonly fileMode: "0600";
  readonly format: "json" | "pem";
  readonly principal?: "standard" | "admin" | "host" | "guest" | "ca";
};

export type ProvisioningSecretStorageContract = {
  readonly rootDirectory: string;
  readonly secretRefs: readonly ProvisioningSecretRef[];
  readonly manifestArtifactKind: "credential";
  readonly redactedResultFields: readonly string[];
};

export type ProvisioningStageContract = {
  readonly id: ProvisioningStageId;
  readonly title: string;
  readonly dependsOn: readonly ProvisioningStageId[];
  readonly readinessChecks: readonly ProvisioningReadinessCheck[];
  readonly script?: ProvisioningScriptInvocationContract;
  readonly producesSecrets: readonly ProvisioningSecretKind[];
  readonly producesSnapshot: boolean;
};

export type ProvisioningStageTransition = {
  readonly from: ProvisioningStageId | "start";
  readonly onSuccess: ProvisioningStageId | "complete";
  readonly onFailure: "blocked";
};

export type ProvisioningStageState = {
  readonly id: ProvisioningStageId;
  readonly status: ProvisioningStageStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: ProvisioningScriptResult;
};

export type ProvisioningStateMachine = {
  readonly version: 1;
  readonly status: ProvisioningRunStatus;
  readonly currentStageId?: ProvisioningStageId;
  readonly stages: readonly ProvisioningStageState[];
  readonly transitions: readonly ProvisioningStageTransition[];
};

export type ProvisioningPlan = {
  readonly version: 1;
  readonly vmName: string;
  readonly stages: readonly ProvisioningStageContract[];
  readonly stateMachine: ProvisioningStateMachine;
  readonly secrets: ProvisioningSecretStorageContract;
};

export type ProvisioningPlanOptions = {
  readonly vmName: string;
  readonly secretsDirectory: string;
  readonly controlPort: number;
  readonly guestAddress: string;
  readonly snapshotName?: string;
};

const POWERSHELL = "powershell.exe";
const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_SCRIPT_TIMEOUT_MS = 45 * 60 * 1000;

export const PROVISIONING_STAGE_TRANSITIONS: readonly ProvisioningStageTransition[] = [
  { from: "start", onSuccess: "media-ready", onFailure: "blocked" },
  { from: "media-ready", onSuccess: "vm-booted", onFailure: "blocked" },
  { from: "vm-booted", onSuccess: "qga-ready", onFailure: "blocked" },
  { from: "qga-ready", onSuccess: "windbg-installed", onFailure: "blocked" },
  { from: "windbg-installed", onSuccess: "guest-agent-installed", onFailure: "blocked" },
  { from: "guest-agent-installed", onSuccess: "policy-configured", onFailure: "blocked" },
  { from: "policy-configured", onSuccess: "local-accounts-created", onFailure: "blocked" },
  { from: "local-accounts-created", onSuccess: "health-checked", onFailure: "blocked" },
  { from: "health-checked", onSuccess: "snapshot-prepared", onFailure: "blocked" },
  { from: "snapshot-prepared", onSuccess: "complete", onFailure: "blocked" },
];

export function buildProvisioningPlan(options: ProvisioningPlanOptions): ProvisioningPlan {
  return {
    version: 1,
    vmName: options.vmName,
    stages: buildProvisioningStageContracts(options),
    stateMachine: createInitialProvisioningStateMachine(),
    secrets: buildProvisioningSecretStorageContract(options.vmName, options.secretsDirectory),
  };
}

export function createInitialProvisioningStateMachine(): ProvisioningStateMachine {
  return {
    version: 1,
    status: "notStarted",
    stages: PROVISIONING_STAGE_IDS.map((id) => ({ id, status: "pending" })),
    transitions: PROVISIONING_STAGE_TRANSITIONS,
  };
}

export function canAdvanceProvisioningStage(
  from: ProvisioningStageId | "start",
  to: ProvisioningStageId | "complete",
): boolean {
  return PROVISIONING_STAGE_TRANSITIONS.some(
    (transition) => transition.from === from && transition.onSuccess === to,
  );
}

export function buildProvisioningSecretStorageContract(
  vmName: string,
  secretsDirectory: string,
): ProvisioningSecretStorageContract {
  const vmSecretsDirectory = path.join(secretsDirectory, sanitizeSecretPathPart(vmName));

  return {
    rootDirectory: vmSecretsDirectory,
    manifestArtifactKind: "credential",
    redactedResultFields: ["password", "privateKey", "certificatePem", "pfxPassword"],
    secretRefs: [
      secretRef("windows-standard-password", "windows/standard-user.json", "json", "standard"),
      secretRef("windows-admin-password", "windows/admin-user.json", "json", "admin"),
      secretRef("mtls-ca-private-key", "mtls/ca.key.pem", "pem", "ca"),
      secretRef("mtls-ca-certificate", "mtls/ca.cert.pem", "pem", "ca"),
      secretRef("mtls-host-client-private-key", "mtls/host-client.key.pem", "pem", "host"),
      secretRef("mtls-host-client-certificate", "mtls/host-client.cert.pem", "pem", "host"),
      secretRef("mtls-guest-server-private-key", "mtls/guest-server.key.pem", "pem", "guest"),
      secretRef("mtls-guest-server-certificate", "mtls/guest-server.cert.pem", "pem", "guest"),
    ].map((ref) => ({ ...ref, path: path.join(vmSecretsDirectory, ref.path) })),
  };
}

function buildProvisioningStageContracts(
  options: ProvisioningPlanOptions,
): readonly ProvisioningStageContract[] {
  return [
    {
      id: "media-ready",
      title: "Media readiness",
      dependsOn: [],
      readinessChecks: [
        requiredCheck(
          "windows-install-media",
          "Windows installation media is present or overridden",
        ),
        requiredCheck("virtio-media", "virtio driver media is present or overridden"),
      ],
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "vm-booted",
      title: "VM boot",
      dependsOn: ["media-ready"],
      readinessChecks: [
        requiredCheck("qmp-running", "QMP reports the VM is running"),
        requiredCheck("qga-channel-present", "QGA virtio serial channel is configured"),
      ],
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "qga-ready",
      title: "QGA readiness",
      dependsOn: ["vm-booted"],
      readinessChecks: [
        requiredCheck("guest-ping", "QGA guest-ping responds before bootstrap scripts run"),
        requiredCheck(
          "powershell-available",
          "PowerShell is available through QGA command execution",
        ),
      ],
      script: script("probe-qga", "qga-powershell", "guest/provision/probe-qga.ps1"),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "windbg-installed",
      title: "WinDbg and CDB installation",
      dependsOn: ["qga-ready"],
      readinessChecks: [
        requiredCheck("cdb-path", "CDB is discoverable on the guest"),
        requiredCheck("windbg-path", "WinDbg is discoverable on the guest"),
        requiredCheck("symbol-path", "Default symbol path is configured"),
      ],
      script: script("install-windbg", "qga-powershell", "guest/provision/install-windbg.ps1", {
        timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
        elevated: true,
      }),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "guest-agent-installed",
      title: "Guest agent installation",
      dependsOn: ["windbg-installed"],
      readinessChecks: [
        requiredCheck("service-installed", "Crucible guest service is installed"),
        requiredCheck("service-running", "Crucible guest service is running"),
        requiredCheck("host-only-firewall", "Guest firewall allows only host-only control traffic"),
      ],
      script: script("install-guest-agent", "qga-powershell", "guest/provision/install-agent.ps1", {
        scriptArguments: [
          "-ControlAddress",
          options.guestAddress,
          "-ControlPort",
          String(options.controlPort),
        ],
        timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
        elevated: true,
      }),
      producesSecrets: [
        "mtls-ca-private-key",
        "mtls-ca-certificate",
        "mtls-host-client-private-key",
        "mtls-host-client-certificate",
        "mtls-guest-server-private-key",
        "mtls-guest-server-certificate",
      ],
      producesSnapshot: false,
    },
    {
      id: "policy-configured",
      title: "Analysis VM policy changes",
      dependsOn: ["guest-agent-installed"],
      readinessChecks: [
        requiredCheck("defender-disabled", "Defender disabled state is recorded"),
        requiredCheck("code-integrity-recorded", "Code-integrity policy state is recorded"),
        requiredCheck(
          "test-signing-disabled",
          "Test signing is disabled unless explicitly overridden",
        ),
      ],
      script: script(
        "configure-analysis-policy",
        "guest-agent-powershell",
        "guest/provision/configure-policy.ps1",
        {
          elevated: true,
        },
      ),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "local-accounts-created",
      title: "Local execution accounts",
      dependsOn: ["policy-configured"],
      readinessChecks: [
        requiredCheck("standard-account", "Standard execution account exists and can log on"),
        requiredCheck("admin-account", "Admin execution account exists and can run elevated tasks"),
      ],
      script: script(
        "create-local-accounts",
        "guest-agent-powershell",
        "guest/provision/create-local-accounts.ps1",
        {
          elevated: true,
        },
      ),
      producesSecrets: ["windows-standard-password", "windows-admin-password"],
      producesSnapshot: false,
    },
    {
      id: "health-checked",
      title: "Provisioning health checks",
      dependsOn: ["local-accounts-created"],
      readinessChecks: [
        requiredCheck("debugger-health", "CDB and WinDbg readiness is reported"),
        requiredCheck("service-health", "Guest service health endpoint is healthy"),
        requiredCheck("execution-contexts", "Standard and admin execution contexts are healthy"),
        requiredCheck(
          "policy-health",
          "Defender, code-integrity, and test-signing states are reported",
        ),
      ],
      script: script(
        "test-provisioning-health",
        "guest-agent-powershell",
        "guest/provision/test-health.ps1",
      ),
      producesSecrets: [],
      producesSnapshot: false,
    },
    {
      id: "snapshot-prepared",
      title: "Snapshot preparation",
      dependsOn: ["health-checked"],
      readinessChecks: [
        requiredCheck("guest-quiesced", "Guest transient state is quiesced before clean snapshot"),
        requiredCheck(
          "snapshot-metadata",
          "Clean snapshot metadata can be written to the artifact manifest",
        ),
      ],
      script: script(
        "prepare-snapshot",
        "guest-agent-powershell",
        "guest/provision/prepare-snapshot.ps1",
        {
          scriptArguments: ["-SnapshotName", options.snapshotName ?? "clean-base"],
          elevated: true,
        },
      ),
      producesSecrets: [],
      producesSnapshot: true,
    },
  ];
}

function requiredCheck(id: string, description: string): ProvisioningReadinessCheck {
  return { id, description, required: true };
}

function script(
  id: string,
  runner: ProvisioningScriptRunner,
  scriptPath: string,
  overrides: Partial<
    Pick<ProvisioningScriptInvocationContract, "timeoutMs" | "elevated" | "redactedArgumentIndexes">
  > & {
    readonly scriptArguments?: readonly string[];
  } = {},
): ProvisioningScriptInvocationContract {
  const { scriptArguments, ...contractOverrides } = overrides;

  return {
    id,
    runner,
    executable: POWERSHELL,
    scriptPath,
    arguments: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...(scriptArguments ?? []),
    ],
    timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
    elevated: false,
    redactedArgumentIndexes: [],
    ...contractOverrides,
  };
}

function secretRef(
  kind: ProvisioningSecretKind,
  relativePath: string,
  format: ProvisioningSecretRef["format"],
  principal: ProvisioningSecretRef["principal"],
): ProvisioningSecretRef {
  return {
    kind,
    id: kind,
    path: relativePath,
    fileMode: "0600",
    format,
    principal,
  };
}

function sanitizeSecretPathPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "vm"
  );
}
