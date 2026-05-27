import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseCrucibleConfig } from "@crucible/core";

import { runCrucibleCli } from "./index.js";

describe("crucible CLI bootstrap", () => {
  it("prints help", async () => {
    const result = await runCrucibleCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("crucible provision");
    expect(result.stdout).toContain("crucible mcp");
  });

  it("prints media plan without manual links by default", async () => {
    const result = await runCrucibleCli(["media:plan"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Media profile: windows11-enterprise-eval");
    expect(result.stdout).toContain("media/cache/Windows11EnterpriseEvaluation.iso");
    expect(result.stdout).toContain("media/cache/virtio-win-stable.iso");
    expect(result.stdout).toContain("Windows 11 Enterprise Evaluation");
    expect(result.stdout).toContain("virtio-win");
    expect(result.stdout).toContain("pass --manual");
    expect(result.stdout).not.toContain("Windows Server 2025 Evaluation page");
  });

  it("prints profile-specific manual-download instructions with --manual", async () => {
    const result = await runCrucibleCli(["media:plan", "--manual"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Windows 11 Enterprise Evaluation page");
    expect(result.stdout).toContain("stable virtio-win ISO");
    expect(result.stdout).not.toContain("Windows Server 2025 Evaluation page");
    expect(result.stdout).not.toContain("latest virtio-win ISO");
  });

  it("prints alternate Windows Server media plan", async () => {
    const result = await runCrucibleCli(["media:plan", "--profile", "windows-server-2025-eval"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Media profile: windows-server-2025-eval");
    expect(result.stdout).toContain("media/cache/WindowsServer2025Evaluation.iso");
    expect(result.stdout).not.toContain("Windows 11 Enterprise Evaluation page");
  });

  it("prints isolated network dry-run plan without guest egress", async () => {
    const result = await runCrucibleCli(["net:plan", "--mode", "isolated"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode: isolated");
    expect(result.stdout).toContain("QEMU backend: user");
    expect(result.stdout).toContain("restrict=on");
    expect(result.stdout).toContain("hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443");
    expect(result.stdout).toContain("crucible-test-win-net0-deny-guest-egress");
    expect(result.stdout).toContain("drop");
    expect(result.stdout).toContain("Apply commands are hidden by default");
  });

  it("prints apply model only when explicitly requested", async () => {
    const result = await runCrucibleCli(
      ["net:plan", "--mode", "capture", "--backend", "iptables", "--apply"],
      {
        config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode: capture");
    expect(result.stdout).toContain("Firewall backend: iptables");
    expect(result.stdout).toContain("Firewall apply commands (not executed by net:plan):");
    expect(result.stdout).toContain("Firewall teardown commands (project-owned rules only):");
    expect(result.stdout).toContain("CRUCIBLE-CRUCIBLE-TEST-WIN-NET0");
    expect(result.stdout).not.toContain(" -F ");
    expect(result.stdout).not.toContain("iptables -X FORWARD");
  });

  it("prints network teardown dry-run by default", async () => {
    const result = await runCrucibleCli(["net:teardown", "--mode", "capture"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network teardown dry-run:");
    expect(result.stdout).toContain("Owner: crucible/test-win/crucible-test-win-net0");
    expect(result.stdout).toContain("Missing resources: ignored");
    expect(result.stdout).toContain("Dry-run commands:");
    expect(result.stdout).toContain("interface crucible-test-win-net0-tap");
    expect(result.stdout).toContain("printf");
    expect(result.stdout).not.toContain("iptables -F");
  });

  it("prints network teardown apply model only when explicitly requested", async () => {
    const result = await runCrucibleCli(
      ["net:teardown", "--mode", "capture", "--backend", "iptables", "--apply"],
      {
        config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network teardown apply:");
    expect(result.stdout).toContain("Apply commands:");
    expect(result.stdout).toContain("iptables -D CRUCIBLE-CRUCIBLE-TEST-WIN-NET0");
    expect(result.stdout).toContain("ip link delete dev crucible-test-win-net0-tap");
    expect(result.stdout).not.toContain("iptables -X FORWARD");
  });

  it("rejects unknown network plan options", async () => {
    const result = await runCrucibleCli(["net:plan", "--backend", "pf"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown firewall backend: pf");
  });

  it("rejects unknown network teardown options", async () => {
    const result = await runCrucibleCli(["net:teardown", "--backend", "pf"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown firewall backend: pf");
  });

  it("prints alternate Windows Server manual-download instructions", async () => {
    const result = await runCrucibleCli([
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

  it("rejects unknown media profile", async () => {
    const result = await runCrucibleCli(["media:plan", "--profile", "windows-10"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown media profile: windows-10");
  });

  it("prints vm:create dry-run QEMU planning output", async () => {
    const result = await runCrucibleCli(["vm:create", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VM create dry run:");
    expect(result.stdout).toContain("qemu-img create -f qcow2");
    expect(result.stdout).toContain("qemu-system-x86_64");
    expect(result.stdout).toContain("artifacts/disks/test-win.qcow2");
    expect(result.stdout).toContain("network mode: isolated (user)");
    expect(result.stdout).toContain("guest control: 127.0.0.1:8443 -> 192.0.2.2:8443");
    expect(result.stdout).toContain("qmp socket: artifacts/qmp.sock");
  });

  it("prints vm:start dry-run QEMU planning output", async () => {
    const result = await runCrucibleCli(["vm:start", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VM start dry run:");
    expect(result.stdout).not.toContain("qemu-img create -f qcow2");
    expect(result.stdout).toContain("type=q35,accel=kvm");
    expect(result.stdout).toContain(
      "user,id=crucible-test-win-net0,restrict=on,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
    );
    expect(result.stdout).toContain("qga socket: artifacts/qga.sock");
  });

  it("prints explicit NAT QEMU networking in vm:start dry-run output", async () => {
    const result = await runCrucibleCli(["vm:start", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" }, network: { mode: "nat" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("network mode: nat (user)");
    expect(result.stdout).toContain(
      "user,id=crucible-test-win-net0,restrict=off,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
    );
  });

  it("prints explicit capture QEMU networking in vm:start dry-run output", async () => {
    const result = await runCrucibleCli(["vm:start", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" }, network: { mode: "capture" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("network mode: capture (tap)");
    expect(result.stdout).toContain(
      "tap,id=crucible-test-win-net0,ifname=crucible-test-win-net0-tap,script=no,downscript=no",
    );
  });

  it("uses default config instead of cwd config when tests do not inject runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const result = await runCrucibleCli(["vm:start", "--dry-run"], {
      configPath: path.join(root, "missing.config.json"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("artifacts/disks/crucible-win11.qcow2");
  });

  it("reports the first invalid vm:stop option before extra arguments", async () => {
    const result = await runCrucibleCli(["vm:stop", "--unknown", "--kill"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown vm:stop option: --unknown");
  });

  it("rejects extra vm:stop arguments after a valid option", async () => {
    const result = await runCrucibleCli(["vm:stop", "--kill", "--extra"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown vm:stop option: --extra");
  });

  it("prints stopped VM status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const result = await runCrucibleCli(["vm:status"], {
      config: parseCrucibleConfig({
        vm: { name: "test-win" },
        artifacts: {
          directory: path.join(root, "artifacts"),
          manifestPath: path.join(root, "artifacts", "manifest.json"),
          logsDirectory: path.join(root, "artifacts", "logs"),
          snapshotsDirectory: path.join(root, "snapshots"),
          secretsDirectory: path.join(root, "secrets"),
        },
        qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
        qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status: stopped");
    expect(result.stdout).toContain("pid: none");
  });

  it("prints missing VM logs before the VM has started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const config = parseCrucibleConfig({
      vm: { name: "test-win" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });

    const result = await runCrucibleCli(["vm:logs"], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stdout log:");
    expect(result.stdout).toContain("(missing)");
  });

  it("prints existing VM logs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    const logsDirectory = path.join(root, "artifacts", "logs");
    const config = parseCrucibleConfig({
      vm: { name: "test-win" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory,
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });
    await mkdir(logsDirectory, { recursive: true });
    await writeFile(path.join(logsDirectory, "test-win.stdout.log"), "out\n", "utf8");
    await writeFile(path.join(logsDirectory, "test-win.stderr.log"), "err\n", "utf8");

    const result = await runCrucibleCli(["vm:logs"], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("out");
    expect(result.stdout).toContain("err");
  });
});
