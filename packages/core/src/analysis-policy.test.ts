import { describe, expect, it } from "vitest";

import {
  buildAnalysisVmPolicyReadiness,
  buildAnalysisVmPolicyScriptArguments,
  defaultAnalysisVmPolicyConfig,
  parseAnalysisVmPolicyAudit,
  parseAnalysisVmPolicyConfig,
} from "./analysis-policy.js";

const healthyAudit = {
  schemaVersion: 1,
  mode: "isolated-analysis",
  generatedAt: "2026-05-27T00:00:00.000Z",
  defender: {
    disabled: true,
    realTimeProtectionDisabled: true,
    serviceStatus: "Running",
    preferencesRecorded: true,
  },
  codeIntegrity: {
    stateRecorded: true,
    enforcementDisabled: true,
    hypervisorEnforcedCodeIntegrityDisabled: true,
    bootOptions: ["nointegritychecks"],
  },
  testSigning: {
    enabled: false,
    requiredDisabled: true,
  },
  profile: {
    hostname: "DESKTOP-7F3K9Q2",
    username: "analyst",
    locale: "en-US",
    screenSize: "1920x1080",
    disableSleep: true,
    showFileExtensions: true,
    showHiddenFiles: true,
    showExplorerRibbon: true,
    clearRecentExplorerHistory: true,
    commonAnalysisLabCamouflage: true,
    appliedSettings: ["defender-disabled", "test-signing-disabled", "show-file-extensions"],
  },
  warnings: [],
} as const;

describe("analysis VM policy", () => {
  it("keeps test signing disabled in the default isolated analysis policy", () => {
    expect(defaultAnalysisVmPolicyConfig).toMatchObject({
      isolatedAnalysisVm: true,
      disableDefender: true,
      disableCodeIntegrity: true,
      requireTestSigningDisabled: true,
      profile: {
        locale: "en-US",
        screenSize: "1920x1080",
        disableSleep: true,
        showFileExtensions: true,
        showHiddenFiles: true,
        showExplorerRibbon: true,
        clearRecentExplorerHistory: true,
        commonAnalysisLabCamouflage: false,
      },
    });
  });

  it("rejects attempts to enable a non-analysis policy or disable test-signing enforcement", () => {
    expect(() => parseAnalysisVmPolicyConfig({ isolatedAnalysisVm: false })).toThrow(
      /Invalid input/,
    );
    expect(() => parseAnalysisVmPolicyConfig({ requireTestSigningDisabled: false })).toThrow(
      /Invalid input/,
    );
  });

  it("builds PowerShell arguments for optional malware-reversing profile flags", () => {
    const config = parseAnalysisVmPolicyConfig({
      profile: {
        hostname: "DESKTOP-7F3K9Q2",
        username: "analyst",
        locale: "en-GB",
        screenSize: "1366x768",
        commonAnalysisLabCamouflage: true,
      },
    });

    expect(buildAnalysisVmPolicyScriptArguments(config)).toEqual([
      "-Mode",
      "isolated-analysis",
      "-DisableDefender",
      "$true",
      "-DisableCodeIntegrity",
      "$true",
      "-RequireTestSigningDisabled",
      "$true",
      "-Locale",
      "en-GB",
      "-ScreenSize",
      "1366x768",
      "-DisableSleep",
      "$true",
      "-ShowFileExtensions",
      "$true",
      "-ShowHiddenFiles",
      "$true",
      "-ShowExplorerRibbon",
      "$true",
      "-ClearRecentExplorerHistory",
      "$true",
      "-CommonAnalysisLabCamouflage",
      "$true",
      "-Hostname",
      "DESKTOP-7F3K9Q2",
      "-ProfileUsername",
      "analyst",
    ]);
  });

  it("parses policy audit output and reports readiness", () => {
    const audit = parseAnalysisVmPolicyAudit(JSON.stringify(healthyAudit));
    const checks = buildAnalysisVmPolicyReadiness(audit);

    expect(audit.defender.disabled).toBe(true);
    expect(audit.codeIntegrity.stateRecorded).toBe(true);
    expect(audit.testSigning.enabled).toBe(false);
    expect(checks).toEqual([
      expect.objectContaining({ id: "defender-disabled", passed: true }),
      expect.objectContaining({ id: "code-integrity-recorded", passed: true }),
      expect.objectContaining({ id: "test-signing-disabled", passed: true }),
      expect.objectContaining({ id: "analysis-profile-audited", passed: true }),
    ]);
  });

  it("fails readiness when fixture output reports enabled test signing", () => {
    const audit = parseAnalysisVmPolicyAudit({
      ...healthyAudit,
      testSigning: { enabled: true, requiredDisabled: true },
    });

    expect(buildAnalysisVmPolicyReadiness(audit)).toContainEqual(
      expect.objectContaining({ id: "test-signing-disabled", passed: false }),
    );
  });

  it("fails Defender readiness when real-time protection is still enabled", () => {
    const audit = parseAnalysisVmPolicyAudit({
      ...healthyAudit,
      defender: {
        disabled: true,
        realTimeProtectionDisabled: false,
        serviceStatus: "Running",
        preferencesRecorded: true,
      },
    });

    expect(buildAnalysisVmPolicyReadiness(audit)).toContainEqual(
      expect.objectContaining({
        id: "defender-disabled",
        passed: false,
        message: "Windows Defender is not fully disabled: policy=true, realTime=false",
      }),
    );
  });
});
