import { describe, expect, it } from "vitest";

import { CRUCIBLE_VERSION, getManualDownloadInstructions, MANUAL_DOWNLOADS } from "./index.js";

describe("core bootstrap exports", () => {
  it("exposes a version", () => {
    expect(CRUCIBLE_VERSION).toBe("0.0.0");
  });

  it("includes manual download guidance for default media", () => {
    const instructions = getManualDownloadInstructions("/tmp/crucible-media");

    expect(MANUAL_DOWNLOADS.length).toBeGreaterThan(0);
    expect(instructions).toContain("Windows 11 Enterprise Evaluation");
    expect(instructions).toContain("virtio-win");
    expect(instructions).toContain("/tmp/crucible-media");
  });
});
