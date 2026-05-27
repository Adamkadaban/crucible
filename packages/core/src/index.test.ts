import { describe, expect, it } from "vitest";

import {
  createEmptyArtifactManifest,
  CRUCIBLE_VERSION,
  buildQemuCommandPlan,
  defaultCrucibleConfig,
  describeCommand,
  getManualDownloadInstructions,
  loadCrucibleConfigFile,
  MANUAL_DOWNLOADS,
  parseCrucibleConfig,
  renderQemuDryRun,
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

  it("loads default config when no config file exists", () => {
    expect(loadCrucibleConfigFile("missing-crucible.config.json")).toEqual(defaultCrucibleConfig);
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

  it("builds the default QEMU argv with KVM, virtio-scsi, QMP, and QGA", () => {
    const plan = buildQemuCommandPlan();

    expect(plan.executable).toBe("qemu-system-x86_64");
    expect(plan.args).toContain("type=q35,accel=kvm");
    expect(plan.args).toContain("virtio-scsi-pci,id=scsi0");
    expect(plan.args).toContain("scsi-hd,drive=crucible-disk0");
    expect(plan.args).toContain("virtio-net-pci,netdev=crucible-net0");
    expect(plan.args).toContain("virtio-serial-pci");
    expect(plan.args).toContain("virtserialport,chardev=crucible-qga0,name=org.qemu.guest_agent.0");
    expect(plan.args).toContain("unix:artifacts/qmp.sock,server=on,wait=off");
    expect(plan.args).toContain(
      "socket,path=artifacts/qga.sock,server=on,wait=off,id=crucible-qga0",
    );
    expect(plan.disk).toEqual({
      path: "artifacts/disks/crucible-win11.qcow2",
      format: "qcow2",
      bus: "virtio-scsi",
    });
  });

  it("derives the default qcow2 path from configured artifact and VM names", () => {
    const config = parseCrucibleConfig({
      vm: { name: "analysis-one" },
      artifacts: { directory: "/var/lib/crucible" },
    });
    const plan = buildQemuCommandPlan({ config });

    expect(plan.disk.path).toBe("/var/lib/crucible/disks/analysis-one.qcow2");
    expect(plan.args).toContain(
      "file=/var/lib/crucible/disks/analysis-one.qcow2,if=none,format=qcow2,id=crucible-disk0,cache=none,discard=unmap",
    );
  });

  it("respects custom virtio preferences, sockets, disk path, and extra QEMU args", () => {
    const config = parseCrucibleConfig({
      vm: {
        name: "custom lab",
        cpus: 2,
        memoryMiB: 4096,
        extraQemuArgs: ["-display", "none", "-trace", "events=/tmp/qemu events"],
      },
      virtio: {
        diskBus: "virtio-blk",
        balloon: false,
        rng: false,
      },
      network: {
        mode: "nat",
      },
      qmp: {
        socketPath: "/run/crucible/qmp.sock",
      },
      qga: {
        socketPath: "/run/crucible/qga.sock",
      },
    });
    const plan = buildQemuCommandPlan({ config, diskPath: "/var/lib/crucible/custom.qcow2" });

    expect(plan.args).toContain("custom lab");
    expect(plan.args).toContain("virtio-blk-pci,drive=crucible-disk0");
    expect(plan.args).not.toContain("virtio-scsi-pci,id=scsi0");
    expect(plan.args).not.toContain("virtio-balloon-pci");
    expect(plan.args).not.toContain("virtio-rng-pci,rng=rng0");
    expect(plan.args).toContain("user,id=crucible-net0,restrict=off");
    expect(plan.args).toContain("unix:/run/crucible/qmp.sock,server=on,wait=off");
    expect(plan.args).toContain(
      "socket,path=/run/crucible/qga.sock,server=on,wait=off,id=crucible-qga0",
    );
    expect(plan.args.slice(-4)).toEqual(["-display", "none", "-trace", "events=/tmp/qemu events"]);
    expect(plan.dryRunCommand).toContain("'custom lab'");
    expect(plan.dryRunCommand).toContain("'events=/tmp/qemu events'");
  });

  it("renders dry-run output for CLI lifecycle commands", () => {
    const output = renderQemuDryRun(buildQemuCommandPlan());

    expect(output).toContain("QEMU dry run plan:");
    expect(output).toContain("qemu-system-x86_64");
    expect(output).toContain("qmp socket: artifacts/qmp.sock");
    expect(output).toContain("qga socket: artifacts/qga.sock");
  });
});
