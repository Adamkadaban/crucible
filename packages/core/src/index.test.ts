import { describe, expect, it } from "vitest";

import {
  createEmptyArtifactManifest,
  CRUCIBLE_VERSION,
  DEFAULT_QMP_TIMEOUT_MS,
  defaultCrucibleConfig,
  describeCommand,
  getManualDownloadInstructions,
  MANUAL_DOWNLOADS,
  parseCrucibleConfig,
} from "./index.js";

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

  it("parses the default lifecycle config", () => {
    expect(defaultCrucibleConfig.vm.name).toBe("crucible-win11");
    expect(defaultCrucibleConfig.media.profile).toBe("windows11-enterprise-eval");
    expect(defaultCrucibleConfig.network.mode).toBe("isolated");
    expect(defaultCrucibleConfig.virtio.diskBus).toBe("virtio-scsi");
    expect(defaultCrucibleConfig.qmp.timeoutMs).toBe(DEFAULT_QMP_TIMEOUT_MS);
  });

  it("accepts custom media overrides and qemu args", () => {
    const config = parseCrucibleConfig({
      vm: {
        name: "lab-one",
        extraQemuArgs: ["-cpu", "host"],
      },
      media: {
        windowsIso: { path: "/isos/win11.iso" },
        virtioIso: {
          url: "https://example.com/virtio.iso",
          sha256: "a".repeat(64),
        },
      },
    });

    expect(config.vm.name).toBe("lab-one");
    expect(config.vm.extraQemuArgs).toEqual(["-cpu", "host"]);
    expect(config.media.windowsIso?.path).toBe("/isos/win11.iso");
    expect(config.media.virtioIso?.sha256).toBe("a".repeat(64));
  });

  it("rejects empty media overrides", () => {
    expect(() => parseCrucibleConfig({ media: { windowsIso: {} } })).toThrow(
      /media override must include path or url/,
    );
  });

  it("rejects unknown config keys", () => {
    expect(() => parseCrucibleConfig({ media: { cacheDirectory: "typo" } })).toThrow(
      /Unrecognized key/,
    );
  });

  it("creates empty artifact manifests", () => {
    expect(createEmptyArtifactManifest("lab-one")).toEqual({
      version: 1,
      vmName: "lab-one",
      artifacts: [],
    });
  });

  it("describes process commands", () => {
    expect(
      describeCommand({ executable: "qemu-system-x86_64", args: ["-enable-kvm"], timeoutMs: 1000 }),
    ).toBe("qemu-system-x86_64 -enable-kvm");
  });
});
