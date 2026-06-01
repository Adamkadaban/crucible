import { describe, expect, it } from "vitest";

import {
  buildNetworkModeChangePlan,
  buildNetworkPlan,
  buildNetworkRuntimeStatus,
  buildNetworkTeardownOutputModel,
} from "./network.js";

function planFor(mode: "isolated" | "nat" | "capture") {
  return buildNetworkPlan({
    config: { mode, controlPort: 8443 },
    vmName: "test-vm",
    networkDevice: "virtio-net-pci",
  });
}

describe("capture network mode", () => {
  it("capture mode produces a tap backend", () => {
    const plan = planFor("capture");
    expect(plan.qemu.backend).toBe("tap");
    expect(plan.qemu.args.some((a) => a.includes("tap,"))).toBe(true);
  });

  it("capture mode with pcapPath includes filter-dump in args", () => {
    const plan = buildNetworkPlan({
      config: { mode: "capture", controlPort: 8443, pcapPath: "/tmp/test.pcap" },
      vmName: "test-vm",
      networkDevice: "virtio-net-pci",
    });
    expect(plan.qemu.args.some((a) => a.includes("filter-dump"))).toBe(true);
    expect(plan.qemu.args.some((a) => a.includes("/tmp/test.pcap"))).toBe(true);
    expect(plan.qemu.pcapPath).toBe("/tmp/test.pcap");
  });

  it("capture mode without pcapPath omits filter-dump", () => {
    const plan = planFor("capture");
    expect(plan.qemu.args.some((a) => a.includes("filter-dump"))).toBe(false);
    expect(plan.qemu.pcapPath).toBeUndefined();
  });

  it("capture firewall rules include counter accept", () => {
    const plan = planFor("capture");
    const captureRule = plan.firewall.rules.find((r) => r.intent === "capture-guest-traffic");
    expect(captureRule).toBeDefined();
    // The nftables expression for capture-guest-traffic includes "counter accept"
    const applyCommands = plan.firewall.apply;
    const captureCmd = applyCommands.find((c) => c.description.includes("Route guest traffic"));
    expect(captureCmd).toBeDefined();
    // The argv should contain counter and accept for nftables backend
    expect(captureCmd!.argv.some((a) => a === "counter")).toBe(true);
    expect(captureCmd!.argv.some((a) => a === "accept")).toBe(true);
  });

  it("isolated to capture mode change requires restart", () => {
    const current = planFor("isolated");
    const requested = planFor("capture");
    const change = buildNetworkModeChangePlan({ current, requested });
    expect(change.restartRequired).toBe(true);
    expect(change.appliedLive).toBe(false);
    expect(change.currentMode).toBe("isolated");
    expect(change.requestedMode).toBe("capture");
  });

  it("capture to capture reports no restart needed", () => {
    const current = planFor("capture");
    const requested = planFor("capture");
    const change = buildNetworkModeChangePlan({ current, requested });
    expect(change.restartRequired).toBe(false);
    expect(change.appliedLive).toBe(true);
  });

  it("capture runtime status reports captured egress", () => {
    const plan = planFor("capture");
    const status = buildNetworkRuntimeStatus(plan);
    expect(status.guestEgress).toBe("captured");
    expect(status.configuredMode).toBe("capture");
    expect(status.backend).toBe("tap");
  });

  it("capture teardown includes tap interface deletion", () => {
    const plan = planFor("capture");
    const teardown = buildNetworkTeardownOutputModel({ plan });
    const tapCmd = teardown.commands.find((c) => c.description.includes("tap interface"));
    expect(tapCmd).toBeDefined();
    // dry-run wraps with printf, so check the joined argv string
    expect(tapCmd!.argv.join(" ")).toContain("delete");
    expect(tapCmd!.resource.kind).toBe("interface");
  });

  it("isolated mode produces user backend", () => {
    const plan = planFor("isolated");
    expect(plan.qemu.backend).toBe("user");
    expect(plan.qemu.args.some((a) => a.includes("user,"))).toBe(true);
    expect(plan.qemu.args.some((a) => a.includes("restrict=on"))).toBe(true);
  });

  it("nat mode allows egress", () => {
    const plan = planFor("nat");
    const status = buildNetworkRuntimeStatus(plan);
    expect(status.guestEgress).toBe("allowed");
    expect(plan.qemu.backend).toBe("user");
    expect(plan.qemu.args.some((a) => a.includes("restrict=off"))).toBe(true);
  });
});
