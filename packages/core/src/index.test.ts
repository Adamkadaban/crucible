import { describe, expect, it } from "vitest";

import {
  buildMediaCachePlan,
  createEmptyArtifactManifest,
  CRUCIBLE_VERSION,
  DEFAULT_MEDIA_SOURCES,
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

  it("renders manual download guidance from a caller-selected download list", () => {
    const instructions = getManualDownloadInstructions("/tmp/crucible-media", [
      {
        kind: "virtioIso",
        name: "stable virtio-win ISO",
        url: "https://example.com/virtio-win.iso",
        cacheFileName: "virtio-win-stable.iso",
      },
    ]);

    expect(instructions).toContain("stable virtio-win ISO");
    expect(instructions).toContain("/tmp/crucible-media/virtio-win-stable.iso");
    expect(instructions).not.toContain("Windows 11 Enterprise Evaluation");
  });

  it("builds the default Windows 11 desktop media plan", () => {
    const plan = buildMediaCachePlan();

    expect(plan.profile).toBe("windows11-enterprise-eval");
    expect(plan.entries).toEqual([
      expect.objectContaining({
        kind: "windowsIso",
        name: "Windows 11 Enterprise Evaluation ISO",
        cachePath: "media/cache/Windows11EnterpriseEvaluation.iso",
        required: true,
      }),
      expect.objectContaining({
        kind: "virtioIso",
        name: "stable virtio-win ISO",
        cachePath: "media/cache/virtio-win-stable.iso",
        required: true,
      }),
      expect.objectContaining({
        kind: "driverBundle",
        name: "latest virtio-win guest tools",
        cachePath: "media/cache/virtio-win-guest-tools.exe",
        required: false,
      }),
    ]);
    expect(DEFAULT_MEDIA_SOURCES).toHaveLength(4);
    expect(plan.manualDownloads.map((download) => download.cacheFileName)).toEqual([
      "Windows11EnterpriseEvaluation.iso",
      "Windows11EnterpriseEvaluation.iso",
      "virtio-win-stable.iso",
      "virtio-win-guest-tools.exe",
    ]);
    expect(plan.manualDownloads).not.toContainEqual(
      expect.objectContaining({ cacheFileName: "WindowsServer2025Evaluation.iso" }),
    );
    expect(plan.manualDownloads).not.toContainEqual(
      expect.objectContaining({ cacheFileName: "virtio-win-latest.iso" }),
    );
  });

  it("builds the alternate Windows Server media plan", () => {
    const plan = buildMediaCachePlan({ profile: "windows-server-2025-eval" });

    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        kind: "windowsIso",
        name: "Windows Server 2025 Evaluation ISO",
        cachePath: "media/cache/WindowsServer2025Evaluation.iso",
      }),
    );
    expect(plan.entries.map((entry) => entry.kind)).toEqual([
      "windowsIso",
      "virtioIso",
      "driverBundle",
    ]);
    expect(plan.manualDownloads.map((download) => download.cacheFileName)).toEqual([
      "WindowsServer2025Evaluation.iso",
      "WindowsServer2025Evaluation.iso",
      "virtio-win-stable.iso",
      "virtio-win-guest-tools.exe",
    ]);
    expect(plan.manualDownloads).not.toContainEqual(
      expect.objectContaining({ cacheFileName: "Windows11EnterpriseEvaluation.iso" }),
    );
    expect(plan.manualDownloads).not.toContainEqual(
      expect.objectContaining({ cacheFileName: "virtio-win-latest.iso" }),
    );
  });

  it("applies operator media overrides to the plan", () => {
    const plan = buildMediaCachePlan({
      cacheDir: "/var/cache/crucible/media",
      profile: "windows11-enterprise-eval",
      windowsIso: { path: "/isos/custom-win11.iso" },
      virtioIso: { url: "https://example.com/custom-virtio.iso", sha256: "b".repeat(64) },
      driverBundle: { path: "/drivers/virtio-tools.zip" },
    });

    expect(plan.entries).toEqual([
      expect.objectContaining({
        cachePath: "/isos/custom-win11.iso",
        overridePath: "/isos/custom-win11.iso",
      }),
      expect.objectContaining({
        sourceUrl: "https://example.com/custom-virtio.iso",
        cachePath: "/var/cache/crucible/media/virtio-win-stable.iso",
        sha256: "b".repeat(64),
      }),
      expect.objectContaining({
        cachePath: "/drivers/virtio-tools.zip",
        overridePath: "/drivers/virtio-tools.zip",
      }),
    ]);
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
          url: "https://example.com/virtio.ISO",
          sha256: "a".repeat(64),
        },
        driverBundle: { path: "/drivers/virtio-tools.EXE" },
      },
    });

    expect(config.vm.name).toBe("lab-one");
    expect(config.vm.extraQemuArgs).toEqual(["-cpu", "host"]);
    expect(config.media.windowsIso?.path).toBe("/isos/win11.iso");
    expect(config.media.virtioIso?.sha256).toBe("a".repeat(64));
    expect(config.media.virtioIso?.url).toBe("https://example.com/virtio.ISO");
    expect(config.media.driverBundle?.path).toBe("/drivers/virtio-tools.EXE");
  });

  it("rejects empty media overrides", () => {
    expect(() => parseCrucibleConfig({ media: { windowsIso: {} } })).toThrow(
      /media override must include path or url/,
    );
  });

  it("rejects invalid media override extensions", () => {
    expect(() =>
      parseCrucibleConfig({ media: { windowsIso: { path: "/isos/windows.img" } } }),
    ).toThrow(/media ISO override paths must end in .iso/);
    expect(() =>
      parseCrucibleConfig({ media: { virtioIso: { url: "https://example.com/virtio.zip" } } }),
    ).toThrow(/media ISO override URLs must end in .iso/);
    expect(() =>
      parseCrucibleConfig({ media: { driverBundle: { path: "/drivers/virtio.txt" } } }),
    ).toThrow(/driver bundle override paths must end in/);
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
