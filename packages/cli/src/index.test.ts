import { describe, expect, it } from "vitest";

import { runCrucibleCli } from "./index.js";

describe("crucible CLI bootstrap", () => {
  it("prints help", () => {
    const result = runCrucibleCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("crucible provision");
    expect(result.stdout).toContain("crucible mcp");
  });

  it("prints media manual-download instructions", () => {
    const result = runCrucibleCli(["media:plan"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Windows 11 Enterprise Evaluation");
    expect(result.stdout).toContain("virtio-win");
  });

  it("prints vm:create dry-run QEMU planning output", () => {
    const result = runCrucibleCli(["vm:create", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VM create dry run:");
    expect(result.stdout).toContain("qemu-img create -f qcow2");
    expect(result.stdout).toContain("qemu-system-x86_64");
    expect(result.stdout).toContain("artifacts/disks/crucible-win11.qcow2");
    expect(result.stdout).toContain("qmp socket: artifacts/qmp.sock");
  });

  it("prints vm:start dry-run QEMU planning output", () => {
    const result = runCrucibleCli(["vm:start", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VM start dry run:");
    expect(result.stdout).toContain("type=q35,accel=kvm");
    expect(result.stdout).toContain("qga socket: artifacts/qga.sock");
  });

  it("rejects lifecycle commands without dry-run while launch behavior is not wired", () => {
    const result = runCrucibleCli(["vm:start"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("vm:start currently supports --dry-run only");
  });
});
