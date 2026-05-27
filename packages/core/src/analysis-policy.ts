import { z } from "zod";

export const analysisVmPolicyProfileSchema = z
  .object({
    hostname: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    locale: z.string().min(1).default("en-US"),
    screenSize: z
      .string()
      .regex(/^\d{3,5}x\d{3,5}$/)
      .default("1920x1080"),
    disableSleep: z.boolean().default(true),
    showFileExtensions: z.boolean().default(true),
    showHiddenFiles: z.boolean().default(true),
    showExplorerRibbon: z.boolean().default(true),
    clearRecentExplorerHistory: z.boolean().default(true),
    commonAnalysisLabCamouflage: z.boolean().default(false),
  })
  .strict();

export const analysisVmPolicyConfigSchema = z
  .object({
    isolatedAnalysisVm: z.literal(true).default(true),
    disableDefender: z.boolean().default(true),
    disableCodeIntegrity: z.boolean().default(true),
    requireTestSigningDisabled: z.literal(true).default(true),
    profile: z.preprocess((value) => value ?? {}, analysisVmPolicyProfileSchema),
  })
  .strict();

export type AnalysisVmPolicyProfile = z.output<typeof analysisVmPolicyProfileSchema>;
export type AnalysisVmPolicyConfig = z.output<typeof analysisVmPolicyConfigSchema>;
export type AnalysisVmPolicyConfigInput = z.input<typeof analysisVmPolicyConfigSchema>;

export type AnalysisVmPolicyReadiness = {
  readonly id: string;
  readonly passed: boolean;
  readonly message: string;
};

export type AnalysisVmPolicyAudit = {
  readonly schemaVersion: 1;
  readonly mode: "isolated-analysis";
  readonly generatedAt: string;
  readonly defender: {
    readonly disabled: boolean;
    readonly realTimeProtectionDisabled: boolean;
    readonly serviceStatus: string;
    readonly preferencesRecorded: boolean;
  };
  readonly codeIntegrity: {
    readonly stateRecorded: boolean;
    readonly enforcementDisabled: boolean;
    readonly hypervisorEnforcedCodeIntegrityDisabled: boolean;
    readonly bootOptions: readonly string[];
  };
  readonly testSigning: {
    readonly enabled: boolean;
    readonly requiredDisabled: boolean;
  };
  readonly profile: {
    readonly hostname?: string;
    readonly username?: string;
    readonly locale: string;
    readonly screenSize: string;
    readonly disableSleep: boolean;
    readonly showFileExtensions: boolean;
    readonly showHiddenFiles: boolean;
    readonly showExplorerRibbon: boolean;
    readonly clearRecentExplorerHistory: boolean;
    readonly commonAnalysisLabCamouflage: boolean;
    readonly appliedSettings: readonly string[];
  };
  readonly warnings: readonly string[];
};

const analysisVmPolicyAuditSchema: z.ZodType<AnalysisVmPolicyAudit> = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("isolated-analysis"),
    generatedAt: z.string().min(1),
    defender: z
      .object({
        disabled: z.boolean(),
        realTimeProtectionDisabled: z.boolean(),
        serviceStatus: z.string(),
        preferencesRecorded: z.boolean(),
      })
      .strict(),
    codeIntegrity: z
      .object({
        stateRecorded: z.boolean(),
        enforcementDisabled: z.boolean(),
        hypervisorEnforcedCodeIntegrityDisabled: z.boolean(),
        bootOptions: z.array(z.string()),
      })
      .strict(),
    testSigning: z
      .object({
        enabled: z.boolean(),
        requiredDisabled: z.boolean(),
      })
      .strict(),
    profile: z
      .object({
        hostname: z.string().min(1).optional(),
        username: z.string().min(1).optional(),
        locale: z.string().min(1),
        screenSize: z.string().min(1),
        disableSleep: z.boolean(),
        showFileExtensions: z.boolean(),
        showHiddenFiles: z.boolean(),
        showExplorerRibbon: z.boolean(),
        clearRecentExplorerHistory: z.boolean(),
        commonAnalysisLabCamouflage: z.boolean(),
        appliedSettings: z.array(z.string()),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();

export const defaultAnalysisVmPolicyConfig = parseAnalysisVmPolicyConfig({});

export function parseAnalysisVmPolicyConfig(input: unknown): AnalysisVmPolicyConfig {
  return analysisVmPolicyConfigSchema.parse(input);
}

export function buildAnalysisVmPolicyScriptArguments(
  config: AnalysisVmPolicyConfig = defaultAnalysisVmPolicyConfig,
): readonly string[] {
  const args = [
    "-Mode",
    "isolated-analysis",
    "-DisableDefender",
    boolArg(config.disableDefender),
    "-DisableCodeIntegrity",
    boolArg(config.disableCodeIntegrity),
    "-RequireTestSigningDisabled",
    boolArg(config.requireTestSigningDisabled),
    "-Locale",
    config.profile.locale,
    "-ScreenSize",
    config.profile.screenSize,
    "-DisableSleep",
    boolArg(config.profile.disableSleep),
    "-ShowFileExtensions",
    boolArg(config.profile.showFileExtensions),
    "-ShowHiddenFiles",
    boolArg(config.profile.showHiddenFiles),
    "-ShowExplorerRibbon",
    boolArg(config.profile.showExplorerRibbon),
    "-ClearRecentExplorerHistory",
    boolArg(config.profile.clearRecentExplorerHistory),
    "-CommonAnalysisLabCamouflage",
    boolArg(config.profile.commonAnalysisLabCamouflage),
  ];

  if (config.profile.hostname !== undefined) {
    args.push("-Hostname", config.profile.hostname);
  }

  if (config.profile.username !== undefined) {
    args.push("-ProfileUsername", config.profile.username);
  }

  return args;
}

export function parseAnalysisVmPolicyAudit(input: unknown): AnalysisVmPolicyAudit {
  return analysisVmPolicyAuditSchema.parse(typeof input === "string" ? JSON.parse(input) : input);
}

export function buildAnalysisVmPolicyReadiness(
  audit: AnalysisVmPolicyAudit,
): readonly AnalysisVmPolicyReadiness[] {
  return [
    {
      id: "defender-disabled",
      passed: audit.defender.disabled && audit.defender.realTimeProtectionDisabled,
      message:
        audit.defender.disabled && audit.defender.realTimeProtectionDisabled
          ? "Windows Defender policy is disabled for the isolated analysis VM"
          : `Windows Defender is not fully disabled: policy=${audit.defender.disabled}, realTime=${audit.defender.realTimeProtectionDisabled}`,
    },
    {
      id: "code-integrity-recorded",
      passed: audit.codeIntegrity.stateRecorded,
      message: audit.codeIntegrity.stateRecorded
        ? "Code-integrity policy state is recorded in the audit output"
        : "Code-integrity policy state is missing from the audit output",
    },
    {
      id: "test-signing-disabled",
      passed: audit.testSigning.requiredDisabled && !audit.testSigning.enabled,
      message: audit.testSigning.enabled
        ? "Test signing is enabled and violates the default analysis VM policy"
        : "Test signing is disabled",
    },
    {
      id: "analysis-profile-audited",
      passed: audit.profile.appliedSettings.length > 0,
      message: "Analysis VM environment profile settings are present in the audit output",
    },
  ];
}

function boolArg(value: boolean): string {
  return value ? "$true" : "$false";
}
