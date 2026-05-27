import { describe, expect, it } from "vitest";

import { runCrucibleCli } from "./index.js";

describe("crucible CLI bootstrap", () => {
  it("prints help", () => {
    const result = runCrucibleCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("crucible provision");
    expect(result.stdout).toContain("crucible mcp");
  });

  it("prints media plan without manual links by default", () => {
    const result = runCrucibleCli(["media:plan"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Media profile: windows11-enterprise-eval");
    expect(result.stdout).toContain("media/cache/Windows11EnterpriseEvaluation.iso");
    expect(result.stdout).toContain("media/cache/virtio-win-stable.iso");
    expect(result.stdout).toContain("Windows 11 Enterprise Evaluation");
    expect(result.stdout).toContain("virtio-win");
    expect(result.stdout).toContain("pass --manual");
    expect(result.stdout).not.toContain("Windows Server 2025 Evaluation page");
  });

  it("prints profile-specific manual-download instructions with --manual", () => {
    const result = runCrucibleCli(["media:plan", "--manual"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Windows 11 Enterprise Evaluation page");
    expect(result.stdout).toContain("stable virtio-win ISO");
    expect(result.stdout).not.toContain("Windows Server 2025 Evaluation page");
    expect(result.stdout).not.toContain("latest virtio-win ISO");
  });

  it("prints alternate Windows Server media plan", () => {
    const result = runCrucibleCli(["media:plan", "--profile", "windows-server-2025-eval"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Media profile: windows-server-2025-eval");
    expect(result.stdout).toContain("media/cache/WindowsServer2025Evaluation.iso");
    expect(result.stdout).not.toContain("Windows 11 Enterprise Evaluation page");
  });

  it("prints alternate Windows Server manual-download instructions", () => {
    const result = runCrucibleCli([
      "media:plan",
      "--manual",
      "--profile",
      "windows-server-2025-eval",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Windows Server 2025 Evaluation page");
    expect(result.stdout).toContain("stable virtio-win ISO");
    expect(result.stdout).not.toContain("Windows 11 Enterprise Evaluation page");
    expect(result.stdout).not.toContain("latest virtio-win ISO");
  });

  it("rejects unknown media profile", () => {
    const result = runCrucibleCli(["media:plan", "--profile", "windows-10"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown media profile: windows-10");
  });
});
