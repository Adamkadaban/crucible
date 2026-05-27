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
});
