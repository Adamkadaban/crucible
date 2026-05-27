import { describe, expect, it } from "vitest";

import {
  buildMediaCachePlan,
  buildNetworkPlan,
  buildNetworkTeardownOutputModel,
  buildQemuCommandPlan,
  createEmptyArtifactManifest,
  CRUCIBLE_VERSION,
  CrucibleError,
  DEFAULT_MEDIA_SOURCES,
  DEFAULT_QMP_TIMEOUT_MS,
  defaultCrucibleConfig,
  describeCommand,
  getManualDownloadInstructions,
  loadCrucibleConfigFile,
  MANUAL_DOWNLOADS,
  NETWORK_MODES,
  parseCrucibleConfig,
  parseNetworkConfig,
  renderQemuCreateDryRun,
  renderQemuStartDryRun,
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

  it("defines the supported network modes", () => {
    expect(NETWORK_MODES).toEqual(["isolated", "nat", "capture"]);
    expect(parseNetworkConfig({})).toEqual({ mode: "isolated", controlPort: 8443 });
  });

  it("rejects unknown network modes and invalid control ports", () => {
    expect(() => parseNetworkConfig({ mode: "bridge" })).toThrow(/Invalid option/);
    expect(() => parseNetworkConfig({ controlPort: 0 })).toThrow(/Too small/);
  });

  it("plans isolated networking with restricted host-only QEMU control mapping", () => {
    const plan = buildNetworkPlan({
      config: parseNetworkConfig({ mode: "isolated", controlPort: 9443 }),
      vmName: "analysis-one",
    });

    expect(plan.mode).toBe("isolated");
    expect(plan.qemu).toMatchObject({
      backend: "user",
      netdevId: "crucible-analysis-one-net0",
      deviceModel: "virtio-net-pci",
      args: [
        "-netdev",
        "user,id=crucible-analysis-one-net0,restrict=on,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:9443-192.0.2.2:9443",
        "-device",
        "virtio-net-pci,netdev=crucible-analysis-one-net0",
      ],
      controlAddress: {
        hostAddress: "192.0.2.1",
        guestAddress: "192.0.2.2",
        prefixLength: 30,
        guestApiPort: 9443,
      },
      portForwards: [
        {
          protocol: "tcp",
          hostListenAddress: "127.0.0.1",
          hostPort: 9443,
          guestAddress: "192.0.2.2",
          guestPort: 9443,
        },
      ],
    });
    expect(plan.firewall.defaultOperation).toBe("dry-run");
    expect(plan.firewall.backend).toBe("nftables");
    expect(plan.firewall.rules.map((rule) => rule.intent)).toEqual([
      "allow-host-control",
      "deny-guest-egress",
    ]);
    expect(plan.firewall.dryRun.map((command) => command.argv[0])).toEqual([
      "printf",
      "printf",
      "printf",
      "printf",
    ]);
    expect(plan.firewall.apply.map((command) => command.argv[0])).toEqual([
      "nft",
      "nft",
      "nft",
      "nft",
    ]);
    expect(plan.firewall.apply.at(-1)?.argv).toContain("drop");
    expect(plan.teardown).toEqual({
      owner: {
        project: "crucible",
        vmName: "analysis-one",
        resourceId: "crucible-analysis-one-net0",
      },
      firewallCommandIds: ["crucible-analysis-one-net0-table"],
      interfaceNames: [],
    });
  });

  it("scopes default network ownership IDs to the VM name", () => {
    const first = buildNetworkPlan({
      config: parseNetworkConfig({ mode: "capture" }),
      vmName: "analysis one",
    });
    const second = buildNetworkPlan({
      config: parseNetworkConfig({ mode: "capture" }),
      vmName: "analysis-two",
    });

    expect(first.qemu.netdevId).toBe("crucible-analysis-one-net0");
    expect(first.teardown.interfaceNames).toEqual(["crucible-analysis-one-net0-tap"]);
    expect(second.qemu.netdevId).toBe("crucible-analysis-two-net0");
    expect(second.teardown.interfaceNames).toEqual(["crucible-analysis-two-net0-tap"]);
    expect(first.firewall.rules[0]?.id).not.toBe(second.firewall.rules[0]?.id);
  });

  it("rejects netdev IDs that QEMU suboptions would misparse", () => {
    expect(() =>
      buildNetworkPlan({
        config: parseNetworkConfig({ mode: "nat" }),
        vmName: "analysis-one",
        netdevId: "bad,id",
      }),
    ).toThrow(/netdevId cannot contain/);
    expect(() =>
      buildNetworkPlan({
        config: parseNetworkConfig({ mode: "capture" }),
        vmName: "analysis-one",
        netdevId: "bad\\id",
      }),
    ).toThrow(/netdevId cannot contain/);
  });

  it("plans NAT networking as explicit guest egress", () => {
    const plan = buildNetworkPlan({
      config: parseNetworkConfig({ mode: "nat" }),
      vmName: "analysis-one",
    });

    expect(plan.qemu).toMatchObject({
      backend: "user",
      netdevId: "crucible-analysis-one-net0",
      deviceModel: "virtio-net-pci",
      args: [
        "-netdev",
        "user,id=crucible-analysis-one-net0,restrict=off,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
        "-device",
        "virtio-net-pci,netdev=crucible-analysis-one-net0",
      ],
    });
    expect(plan.firewall.rules.map((rule) => rule.intent)).toEqual([
      "allow-host-control",
      "allow-nat-egress",
    ]);
    expect(plan.warnings).toEqual([
      "nat mode grants guest Internet egress and is not the malware-analysis default",
    ]);
  });

  it("can generate iptables firewall plans", () => {
    const plan = buildNetworkPlan({
      config: parseNetworkConfig({ mode: "nat" }),
      firewallBackend: "iptables",
      vmName: "analysis-one",
    });

    expect(plan.firewall.backend).toBe("iptables");
    expect(plan.firewall.rules.map((rule) => rule.table)).toEqual(["iptables", "iptables"]);
    expect(plan.firewall.apply.map((command) => command.argv[0])).toEqual([
      "iptables",
      "iptables",
      "iptables",
      "iptables",
    ]);
    expect(plan.firewall.apply.at(-1)?.argv).toContain("ACCEPT");
  });

  it("plans capture networking with owned tap teardown contract", () => {
    const plan = buildNetworkPlan({
      config: parseNetworkConfig({ mode: "capture" }),
      vmName: "analysis-one",
    });

    expect(plan.qemu).toMatchObject({
      backend: "tap",
      portForwards: [
        {
          protocol: "tcp",
          hostListenAddress: "127.0.0.1",
          hostPort: 8443,
          guestAddress: "192.0.2.2",
          guestPort: 8443,
        },
      ],
      args: [
        "-netdev",
        "tap,id=crucible-analysis-one-net0,ifname=crucible-analysis-one-net0-tap,script=no,downscript=no",
        "-device",
        "virtio-net-pci,netdev=crucible-analysis-one-net0",
      ],
    });
    expect(plan.firewall.rules.map((rule) => rule.intent)).toEqual([
      "allow-host-control",
      "capture-guest-traffic",
    ]);
    expect(plan.teardown.interfaceNames).toEqual(["crucible-analysis-one-net0-tap"]);
    expect(plan.firewall.rules.every((rule) => rule.owner.project === "crucible")).toBe(true);
  });

  it("builds idempotent network teardown dry-run and apply output models", () => {
    const plan = buildNetworkPlan({
      config: parseNetworkConfig({ mode: "capture" }),
      firewallBackend: "iptables",
      vmName: "analysis-one",
    });

    const dryRun = buildNetworkTeardownOutputModel({ plan });
    const apply = buildNetworkTeardownOutputModel({ operation: "apply", plan });

    expect(dryRun.operation).toBe("dry-run");
    expect(apply.operation).toBe("apply");
    expect(dryRun.commands.every((command) => command.missingResourceOk)).toBe(true);
    expect(apply.commands.every((command) => command.missingResourceOk)).toBe(true);
    expect(dryRun.commands.map((command) => command.resource)).toEqual(
      apply.commands.map((command) => command.resource),
    );
    expect(dryRun.commands.map((command) => command.argv[0])).toEqual([
      "printf",
      "printf",
      "printf",
      "printf",
      "printf",
    ]);
    expect(apply.commands.at(-1)).toMatchObject({
      argv: ["ip", "link", "delete", "dev", "crucible-analysis-one-net0-tap"],
      resource: {
        kind: "interface",
        name: "crucible-analysis-one-net0-tap",
      },
    });
  });

  it("refuses network teardown resources without exact project ownership", () => {
    const plan = buildNetworkPlan({
      config: parseNetworkConfig({ mode: "capture" }),
      vmName: "analysis-one",
    });
    const model = buildNetworkTeardownOutputModel({
      discoveredResources: [
        {
          kind: "interface",
          name: "eth0",
          owner: plan.teardown.owner,
        },
        {
          kind: "firewall",
          ruleId: plan.firewall.teardown[0]?.ruleId ?? "missing",
          owner: {
            project: "crucible",
            vmName: "analysis-two",
            resourceId: "crucible-analysis-two-net0",
          },
        },
      ],
      plan,
    });

    expect(model.commands).toEqual([]);
    expect(model.refused).toEqual([
      expect.objectContaining({
        reason: "resource is not listed in this network plan teardown contract",
      }),
      expect.objectContaining({ reason: "owner tag does not match this network plan" }),
    ]);
  });

  it("plans default isolated firewall as deny egress without broad deletion", () => {
    const plan = buildNetworkPlan({
      config: parseNetworkConfig({}),
      vmName: "analysis-one",
    });

    const renderedCommands = [
      ...plan.firewall.apply.map((command) => command.argv.join(" ")),
      ...plan.firewall.teardown.map((command) => command.argv.join(" ")),
    ].join("\n");

    expect(plan.mode).toBe("isolated");
    expect(renderedCommands).toContain("drop");
    expect(renderedCommands).toContain(
      "crucible:analysis-one:crucible-analysis-one-net0:deny-guest-egress",
    );
    expect(renderedCommands).not.toMatch(/\bflush\b/);
    expect(renderedCommands).not.toContain("delete table inet filter");
    expect(renderedCommands).not.toContain("delete table ip filter");
    expect(renderedCommands).not.toMatch(/\b-F\b/);
    expect(renderedCommands).not.toContain("iptables -X FORWARD");
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

  it("loads default config when no config file exists", () => {
    expect(loadCrucibleConfigFile("missing-crucible.config.json")).toEqual(defaultCrucibleConfig);
  });

  it("wraps invalid config file failures", () => {
    expect(() => loadCrucibleConfigFile("package.json")).toThrow(CrucibleError);
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
    expect(plan.args).toContain("scsi-hd,drive=crucible-disk0,bus=scsi0.0");
    expect(plan.args).toContain(
      "user,id=crucible-win11-net0,restrict=on,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
    );
    expect(plan.args).toContain("virtio-net-pci,netdev=crucible-win11-net0");
    expect(plan.network.backend).toBe("user");
    expect(plan.network.mode).toBe("isolated");
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
    expect(plan.createDiskCommand).toEqual([
      "qemu-img",
      "create",
      "-f",
      "qcow2",
      "artifacts/disks/crucible-win11.qcow2",
      "128G",
    ]);
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
    expect(plan.args).toContain(
      "user,id=crucible-custom-lab-net0,restrict=off,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
    );
    expect(plan.args).toContain("virtio-net-pci,netdev=crucible-custom-lab-net0");
    expect(plan.network).toMatchObject({ backend: "user", mode: "nat" });
    expect(plan.args).toContain("unix:/run/crucible/qmp.sock,server=on,wait=off");
    expect(plan.args).toContain(
      "socket,path=/run/crucible/qga.sock,server=on,wait=off,id=crucible-qga0",
    );
    expect(plan.args.slice(-4)).toEqual(["-display", "none", "-trace", "events=/tmp/qemu events"]);
    expect(plan.dryRunCommand).toContain("'custom lab'");
    expect(plan.dryRunCommand).toContain("'events=/tmp/qemu events'");
  });

  it("rejects disk paths that QEMU drive suboptions would misparse", () => {
    expect(() => buildQemuCommandPlan({ diskPath: "/var/lib/crucible/bad,disk.qcow2" })).toThrow(
      /diskPath cannot contain/,
    );
  });

  it("rejects derived disk paths that QEMU drive suboptions would misparse", () => {
    const config = parseCrucibleConfig({ vm: { name: "bad,name" } });

    expect(() => buildQemuCommandPlan({ config })).toThrow(/vm\.name cannot contain/);
  });

  it("rejects VM names that QEMU name suboptions would misparse", () => {
    const config = parseCrucibleConfig({ vm: { name: "bad\\name" } });

    expect(() =>
      buildQemuCommandPlan({ config, diskPath: "/var/lib/crucible/safe.qcow2" }),
    ).toThrow(/vm\.name cannot contain/);
  });

  it("rejects QMP socket paths that QEMU suboptions would misparse", () => {
    const config = parseCrucibleConfig({ qmp: { socketPath: "artifacts/qmp,bad.sock" } });

    expect(() => buildQemuCommandPlan({ config })).toThrow(/qmp\.socketPath cannot contain/);
  });

  it("rejects QGA socket paths that QEMU suboptions would misparse", () => {
    const config = parseCrucibleConfig({ qga: { socketPath: "artifacts/qga\\bad.sock" } });

    expect(() => buildQemuCommandPlan({ config })).toThrow(/qga\.socketPath cannot contain/);
  });

  it("renders create dry-run output with disk creation", () => {
    const output = renderQemuCreateDryRun(buildQemuCommandPlan());

    expect(output).toContain("QEMU dry run plan:");
    expect(output).toContain("create disk: qemu-img create -f qcow2");
    expect(output).toContain("qemu-system-x86_64");
    expect(output).toContain("network mode: isolated (user)");
    expect(output).toContain("guest control: 127.0.0.1:8443 -> 192.0.2.2:8443");
    expect(output).toContain("qmp socket: artifacts/qmp.sock");
    expect(output).toContain("qga socket: artifacts/qga.sock");
  });

  it("renders start dry-run output without disk creation", () => {
    const output = renderQemuStartDryRun(buildQemuCommandPlan());

    expect(output).toContain("QEMU dry run plan:");
    expect(output).not.toContain("create disk: qemu-img create -f qcow2");
    expect(output).toContain("qemu-system-x86_64");
    expect(output).toContain("network mode: isolated (user)");
    expect(output).toContain("qmp socket: artifacts/qmp.sock");
  });
});
