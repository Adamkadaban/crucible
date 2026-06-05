import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCrucibleConfig } from "./config.js";
import {
  buildLifecyclePaths,
  VmLifecycleManager,
  type VmProcessController,
  type VmQmpClientFactory,
  type VmQmpSession,
  type VmSpawnRequest,
} from "./lifecycle.js";
import type { ArtifactManifest } from "./manifest.js";
import { buildQemuCommandPlan } from "./qemu.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("VmLifecycleManager", () => {
  it("starts QEMU, writes pid files, logs, and state manifests", async () => {
    const harness = await createLifecycleHarness();

    const result = await harness.manager.start();

    expect(result.pid).toBe(4242);
    expect(result.status).toMatchObject({
      status: "running",
      pid: 4242,
      processAlive: true,
    });
    expect(harness.spawnRequests).toEqual([
      expect.objectContaining({
        executable: "qemu-system-x86_64",
        stdoutLog: harness.paths.stdoutLog,
        stderrLog: harness.paths.stderrLog,
      }),
    ]);
    expect(await readFile(harness.paths.pidFile, "utf8")).toBe("4242\n");
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      version: 1,
      vmName: "life-test",
      state: "running",
      pid: 4242,
      paths: harness.paths,
    });
    const artifactManifest = await readJson<ArtifactManifest>(harness.paths.artifactManifest);
    expect(artifactManifest.version).toBe(1);
    expect(artifactManifest.vmName).toBe("life-test");
    expect(artifactManifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "disk", path: harness.plan.disk.path }),
        expect.objectContaining({ kind: "pidFile", path: harness.paths.pidFile }),
        expect.objectContaining({ kind: "socket", path: harness.paths.qmpSocket }),
        expect.objectContaining({ kind: "log", path: harness.paths.stdoutLog }),
      ]),
    );
  });

  it("waits for QMP readiness before start returns", async () => {
    const harness = await createLifecycleHarness({ qmpConnectFailuresBeforeReady: 2 });

    const result = await harness.manager.start();

    expect(result.status.qmpAvailable).toBe(true);
    expect(harness.qmp.connects).toBeGreaterThanOrEqual(3);
    expect(harness.qmp.commands).toContain("query-status");
  });

  it("fails start when QMP does not become ready", async () => {
    const harness = await createLifecycleHarness({ qmpConnectError: new Error("no qmp") });

    await expect(harness.manager.start()).rejects.toMatchObject({
      code: "QMP_TIMEOUT",
      message: "VM did not become QMP-ready before timeout",
    });
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      state: "running",
      pid: 4242,
    });
  });

  it("bounds QMP readiness attempts by the remaining startup deadline", async () => {
    const harness = await createLifecycleHarness({ qmpQueryNeverResolves: true });

    await expect(harness.manager.start()).rejects.toMatchObject({
      code: "QMP_TIMEOUT",
      message: "VM did not become QMP-ready before timeout",
    });
    expect(harness.qmp.commandTimeouts.length).toBeGreaterThan(0);
    for (const timeoutMs of harness.qmp.commandTimeouts) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(5);
    }
  });

  it("does not attempt QMP operations once the readiness deadline expires", async () => {
    const harness = await createLifecycleHarness({ qmpAdvanceTimeOnConnectMs: 5 });

    await expect(harness.manager.start()).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: "QMP_TIMEOUT" });
      expect(errorDetails(error)).toMatchObject({ cause: "QMP readiness deadline expired" });
      return true;
    });
    expect(harness.qmp.connects).toBe(1);
    expect(harness.qmp.commands).toEqual([]);
  });

  it("reports process failure if the VM exits before QMP readiness timeout", async () => {
    const harness = await createLifecycleHarness({ qmpQueryNeverResolves: true });
    harness.qmp.beforeNeverResolve = () => harness.processes.delete(4242);

    await expect(harness.manager.start()).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      message: "VM process exited before QMP became ready",
    });
  });

  it("rejects start when an owned VM process is already alive", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();

    await expect(harness.manager.start()).rejects.toMatchObject({
      code: "STATE_INVALID",
      message: "VM is already running",
    });
  });

  it("restores stopped state when QEMU spawn fails", async () => {
    const harness = await createLifecycleHarness({ spawnError: new Error("spawn failed") });

    await expect(harness.manager.start()).rejects.toThrow("spawn failed");
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      state: "stopped",
      stoppedAt: "2026-05-27T00:00:00.000Z",
    });
  });

  it("uses QMP quit for graceful stop and marks the VM stopped", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();
    harness.qmp.nextExecute = () => {
      harness.processes.delete(4242);
      return { returnValue: {} };
    };

    const result = await harness.manager.stop();

    expect(result).toMatchObject({
      mode: "stop",
      qmpCommandSent: true,
      killedAfterTimeout: false,
      status: { status: "stopped", processAlive: false },
    });
    expect(harness.qmp.commands.at(-1)).toBe("quit");
    expect(harness.signals).toEqual([]);
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      state: "stopped",
    });
  });

  it("uses QMP system_powerdown for poweroff", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();
    harness.qmp.nextExecute = () => {
      harness.processes.delete(4242);
      return { returnValue: {} };
    };

    const result = await harness.manager.poweroff();

    expect(result).toMatchObject({
      mode: "poweroff",
      qmpCommandSent: true,
      killedAfterTimeout: false,
      status: { status: "poweredOff", processAlive: false },
    });
    expect(harness.qmp.commands.at(-1)).toBe("system_powerdown");
  });

  it("falls back to SIGTERM then SIGKILL when QMP is unavailable and timeout expires", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();
    harness.qmp.connectError = new Error("no qmp");

    const result = await harness.manager.stop();

    expect(result).toMatchObject({
      mode: "stop",
      qmpCommandSent: false,
      signalSent: "SIGKILL",
      killedAfterTimeout: true,
      status: { status: "stopped", processAlive: false },
    });
    expect(harness.signals).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("does not mark stopped when SIGKILL fails to terminate the VM", async () => {
    const harness = await createLifecycleHarness();
    harness.deleteOnKill = false;
    await harness.manager.start();
    harness.qmp.connectError = new Error("no qmp");

    await expect(harness.manager.stop()).rejects.toMatchObject({
      code: "PROCESS_TIMEOUT",
      message: "VM process survived SIGKILL timeout",
    });
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      state: "stopping",
      pid: 4242,
    });
  });

  it("does not mark stopped when explicit kill cannot terminate the VM", async () => {
    const harness = await createLifecycleHarness();
    harness.deleteOnKill = false;
    await harness.manager.start();

    await expect(harness.manager.kill()).rejects.toMatchObject({
      code: "PROCESS_TIMEOUT",
      message: "VM process survived SIGKILL timeout",
    });
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      state: "running",
      pid: 4242,
    });
  });

  it("reports QMP status when the VM is alive", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();
    harness.qmp.nextExecute = () => ({ returnValue: { status: "running" } });

    const status = await harness.manager.status();

    expect(status).toMatchObject({
      status: "running",
      processAlive: true,
      qmpAvailable: true,
      qmpStatus: "running",
    });
    expect(harness.qmp.commands).toContain("query-status");
  });

  it("sweeps stale pid and socket resources only when the process is gone", async () => {
    const harness = await createLifecycleHarness();
    await mkdirFor(harness.paths.pidFile);
    await writeFile(harness.paths.pidFile, "9999\n", "utf8");
    await writeFile(harness.paths.qmpSocket, "stale qmp", "utf8");
    await writeFile(harness.paths.qgaSocket, "stale qga", "utf8");

    const cleanup = await harness.manager.cleanupStaleResources();

    expect(cleanup.removedPaths).toEqual([
      harness.paths.pidFile,
      harness.paths.qmpSocket,
      harness.paths.qgaSocket,
    ]);
    await expect(readFile(harness.paths.pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(harness.paths.qmpSocket, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(cleanup.status.status).toBe("stopped");
  });

  it("preserves the previously-recorded qemu argv when a different manager stops the VM", async () => {
    // Regression for #127: a CLI vm:stop / vm:kill builds a no-bootMedia
    // VmLifecycleManager and used to overwrite state.json's qemu.args with
    // the bare default plan, destroying the historical record of how QEMU
    // was actually launched.
    const root = await createTempDir();
    const config = parseCrucibleConfig({
      vm: { name: "preserve-test" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock"), timeoutMs: 100 },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });
    const paths = buildLifecyclePaths(config);
    await mkdirFor(paths.stateManifest);

    const richArgs = [
      "-name",
      "preserve-test",
      "-drive",
      "file=disk.qcow2,if=none,id=crucible-disk0",
      "-cdrom",
      "Win11.iso",
      "-drive",
      "if=pflash,format=raw,readonly=on,file=OVMF_CODE_4M.fd",
    ];
    await writeFile(
      paths.stateManifest,
      JSON.stringify({
        version: 1,
        vmName: "preserve-test",
        state: "running",
        pid: 4242,
        paths,
        qemu: { executable: "qemu-system-x86_64", args: richArgs },
        lastTransitionAt: "2026-05-28T00:00:00.000Z",
      }),
      "utf8",
    );

    // Build a bare-plan manager — exactly what `pnpm crucible vm:stop`
    // constructs when invoked separately from provision.
    const barePlan = buildQemuCommandPlan({ config });
    expect(barePlan.args).not.toContain("Win11.iso");

    const processes = new Set<number>([4242]);
    const manager = new VmLifecycleManager({
      config,
      plan: barePlan,
      spawner: { spawn: () => Promise.resolve({ pid: 9999 }) },
      processController: {
        isAlive: (pid) => processes.has(pid),
        signal: (pid) => processes.delete(pid),
        waitForExit: (pid) => Promise.resolve(!processes.has(pid)),
      },
      qmpClientFactory: () => new FakeQmpSession(new Error("not used")),
      stopTimeoutMs: 1,
      killTimeoutMs: 1,
      pollIntervalMs: 1,
    });

    await manager.kill();

    const onDisk = JSON.parse(await readFile(paths.stateManifest, "utf8")) as {
      qemu: { args: readonly string[] };
    };
    expect(onDisk.qemu.args).toEqual(richArgs);
  });

  it("reuses previously-recorded qemu argv when starting a stopped provisioned VM", async () => {
    const harness = await createLifecycleHarness({
      configInput: { vm: { display: { mode: "vnc", vncSocketPath: "artifacts/vnc.sock" } } },
    });
    const richArgs = ["-name", "life-test", "-cdrom", "payload.iso"];
    await mkdirFor(harness.paths.stateManifest);
    await writeFile(
      harness.paths.stateManifest,
      JSON.stringify({
        version: 1,
        vmName: "life-test",
        state: "stopped",
        paths: harness.paths,
        qemu: { executable: "qemu-system-x86_64", args: richArgs },
        lastTransitionAt: "2026-05-28T00:00:00.000Z",
      }),
      "utf8",
    );

    await harness.manager.start();

    expect(harness.spawnRequests[0]?.args).toEqual([...richArgs, "-usb", "-device", "usb-tablet"]);
    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      qemu: { args: [...richArgs, "-usb", "-device", "usb-tablet"] },
    });
  });

  it("refreshes recorded network mode args when restarting a provisioned VM", async () => {
    const harness = await createLifecycleHarness({
      configInput: {
        network: { mode: "isolated", controlPort: 18443 },
        vm: { display: { mode: "vnc", vncSocketPath: "artifacts/vnc.sock" } },
      },
    });
    const recordedNatArgs = [
      "-name",
      "life-test",
      "-drive",
      "file=payload.iso,media=cdrom,if=none,readonly=on,id=crucible-payload",
      "-netdev",
      "user,id=crucible-life-test-net0,restrict=off,net=192.0.2.0/29,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:18443-192.0.2.2:18443",
      "-device",
      "virtio-net-pci,netdev=crucible-life-test-net0",
    ];
    await mkdirFor(harness.paths.stateManifest);
    await writeFile(
      harness.paths.stateManifest,
      JSON.stringify({
        version: 1,
        vmName: "life-test",
        state: "stopped",
        paths: harness.paths,
        qemu: { executable: "qemu-system-x86_64", args: recordedNatArgs },
        lastTransitionAt: "2026-05-28T00:00:00.000Z",
      }),
      "utf8",
    );

    await harness.manager.start();

    const startedArgs = harness.spawnRequests[0]?.args ?? [];
    const netdevIndex = startedArgs.indexOf("-netdev");
    expect(startedArgs[netdevIndex + 1]).toContain("id=crucible-life-test-net0");
    expect(startedArgs[netdevIndex + 1]).toContain("restrict=on");
    expect(startedArgs[netdevIndex + 1]).not.toContain("restrict=off");
    expect(startedArgs).toContain(
      "file=payload.iso,media=cdrom,if=none,readonly=on,id=crucible-payload",
    );
  });

  it("does not add GUI input devices when restarting a headless provisioned VM", async () => {
    const root = await createTempDir();
    const config = parseCrucibleConfig({
      vm: { name: "headless-test", display: { mode: "none" } },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock"), timeoutMs: 100 },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });
    const plan = buildQemuCommandPlan({ config });
    const paths = buildLifecyclePaths(config);
    const richArgs = ["-name", "headless-test", "-cdrom", "payload.iso"];
    await mkdirFor(paths.stateManifest);
    await writeFile(
      paths.stateManifest,
      JSON.stringify({
        version: 1,
        vmName: "headless-test",
        state: "stopped",
        paths,
        qemu: { executable: "qemu-system-x86_64", args: richArgs },
        lastTransitionAt: "2026-05-28T00:00:00.000Z",
      }),
      "utf8",
    );
    const spawnRequests: VmSpawnRequest[] = [];
    const processes = new Set<number>();
    const manager = new VmLifecycleManager({
      config,
      plan,
      spawner: {
        spawn(request) {
          spawnRequests.push(request);
          processes.add(4242);
          return Promise.resolve({ pid: 4242 });
        },
      },
      processController: {
        isAlive: (pid) => processes.has(pid),
        signal: () => undefined,
        waitForExit: () => Promise.resolve(true),
      },
      qmpClientFactory: () => new FakeQmpSession(),
    });

    await manager.start();

    expect(spawnRequests[0]?.args).toEqual(richArgs);
  });

  it("recovers provisioned OVMF and payload args if state was clobbered by a bare plan", async () => {
    const harness = await createLifecycleHarness();
    await mkdirFor(harness.paths.stateManifest);
    await writeFile(
      harness.paths.stateManifest,
      JSON.stringify({
        version: 1,
        vmName: "life-test",
        state: "stopped",
        paths: harness.paths,
        qemu: { executable: "qemu-system-x86_64", args: ["-name", "life-test"] },
        lastTransitionAt: "2026-05-28T00:00:00.000Z",
      }),
      "utf8",
    );
    const ovmfVars = path.join(
      harness.config.artifacts.directory,
      "boot",
      "life-test.OVMF_VARS.fd",
    );
    const payloadIso = path.join(
      harness.config.artifacts.directory,
      "boot",
      "crucible-payload.iso",
    );
    await mkdirFor(ovmfVars);
    await writeFile(ovmfVars, "vars");
    await writeFile(payloadIso, "iso");

    await harness.manager.start();

    expect(harness.spawnRequests[0]?.args.some((arg) => arg.includes("OVMF_CODE"))).toBe(true);
    expect(harness.spawnRequests[0]?.args).toContain(
      "ide-cd,drive=crucible-payload,bus=crucible-sata0.3",
    );
  });

  it("prefers explicit installer boot plan over stale stopped state", async () => {
    const harness = await createLifecycleHarness({
      plan: {
        bootMedia: {
          windowsIsoPath: "/isos/windows.iso",
          autounattendIsoPath: "artifacts/boot/autounattend.iso",
          payloadIsoPath: "artifacts/boot/crucible-payload.iso",
          ovmfCodePath: "/usr/share/OVMF/OVMF_CODE_4M.fd",
          ovmfVarsPath: "artifacts/boot/life-test.OVMF_VARS.fd",
        },
      },
    });
    await mkdirFor(harness.paths.stateManifest);
    await writeFile(
      harness.paths.stateManifest,
      JSON.stringify({
        version: 1,
        vmName: "life-test",
        state: "stopped",
        paths: harness.paths,
        qemu: {
          executable: "qemu-system-x86_64",
          args: [
            "-drive",
            "file=artifacts/boot/crucible-payload.iso,media=cdrom,if=none,readonly=on,id=crucible-payload",
          ],
        },
        lastTransitionAt: "2026-05-28T00:00:00.000Z",
      }),
      "utf8",
    );

    await harness.manager.start();

    expect(harness.spawnRequests[0]?.args).toContain(
      "ide-cd,drive=crucible-windows-install,bus=crucible-sata0.0,bootindex=1",
    );
    expect(harness.spawnRequests[0]?.args).toContain(
      "ide-cd,drive=crucible-autounattend,bus=crucible-sata0.1",
    );
  });

  it("stop when VM is already stopped returns clean result without signals", async () => {
    const harness = await createLifecycleHarness();

    const result = await harness.manager.stop();

    expect(result).toMatchObject({
      mode: "stop",
      qmpCommandSent: false,
      killedAfterTimeout: false,
    });
    expect(harness.signals).toEqual([]);
  });

  it("kill when VM is already stopped returns clean result", async () => {
    const harness = await createLifecycleHarness();

    const result = await harness.manager.kill();

    expect(result).toMatchObject({
      qmpCommandSent: false,
      killedAfterTimeout: false,
    });
    expect(harness.signals).toEqual([]);
  });

  it("status returns stale when pid file has dead pid", async () => {
    const harness = await createLifecycleHarness();
    await mkdirFor(harness.paths.pidFile);
    await writeFile(harness.paths.pidFile, "9999\n", "utf8");

    const status = await harness.manager.status();

    expect(status.status).toBe("stale");
  });

  it("status includes QMP warning when QMP connect fails on alive process", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();
    harness.qmp.connectError = new Error("socket hangup");

    const status = await harness.manager.status();

    expect(status.warnings.length).toBeGreaterThan(0);
  });

  it("poweroff when VM is already stopped", async () => {
    const harness = await createLifecycleHarness();

    const result = await harness.manager.poweroff();

    expect(result.mode).toBe("poweroff");
    expect(result.status.status).toBe("poweredOff");
  });

  it("cleanupStaleResources skips cleanup when process is alive", async () => {
    const harness = await createLifecycleHarness();
    await harness.manager.start();

    const cleanup = await harness.manager.cleanupStaleResources();

    expect(cleanup.removedPaths).toEqual([]);
  });

  it("stop with graceful SIGTERM exit (no SIGKILL needed)", async () => {
    const root = await createTempDir();
    const config = parseCrucibleConfig({
      vm: { name: "life-test" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock"), timeoutMs: 100 },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });
    const plan = buildQemuCommandPlan({ config });
    const processes = new Set<number>();
    const signals: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }> = [];
    const qmp = new FakeQmpSession();
    const manager = new VmLifecycleManager({
      config,
      plan,
      spawner: {
        spawn() {
          processes.add(4242);
          return Promise.resolve({ pid: 4242 });
        },
      },
      processController: {
        isAlive: (pid) => processes.has(pid),
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          if (signal === "SIGTERM") {
            processes.delete(pid);
          }
        },
        waitForExit: (pid) => Promise.resolve(!processes.has(pid)),
      },
      qmpClientFactory: () => qmp,
      stopTimeoutMs: 1,
      killTimeoutMs: 1,
      pollIntervalMs: 1,
    });

    await manager.start();
    qmp.connectError = new Error("no qmp");
    const result = await manager.stop();

    expect(result.killedAfterTimeout).toBe(false);
    expect(result.signalSent).toBe("SIGTERM");
  });

  it("preserves recorded qemu argv if restart spawn fails", async () => {
    const harness = await createLifecycleHarness({ spawnError: new Error("spawn failed") });
    const richArgs = ["-name", "life-test", "-cdrom", "payload.iso"];
    await mkdirFor(harness.paths.stateManifest);
    await writeFile(
      harness.paths.stateManifest,
      JSON.stringify({
        version: 1,
        vmName: "life-test",
        state: "stopped",
        paths: harness.paths,
        qemu: { executable: "qemu-system-x86_64", args: richArgs },
        lastTransitionAt: "2026-05-28T00:00:00.000Z",
      }),
      "utf8",
    );

    await expect(harness.manager.start()).rejects.toThrow("spawn failed");

    await expect(readJson(harness.paths.stateManifest)).resolves.toMatchObject({
      state: "stopped",
      qemu: { args: richArgs },
    });
  });
});

type HarnessOptions = {
  readonly qmpConnectError?: Error;
  readonly qmpConnectFailuresBeforeReady?: number;
  readonly qmpAdvanceTimeOnConnectMs?: number;
  readonly qmpQueryNeverResolves?: boolean;
  readonly spawnError?: Error;
  readonly plan?: Parameters<typeof buildQemuCommandPlan>[0];
  readonly configInput?: {
    readonly vm?: Record<string, unknown>;
    readonly network?: Record<string, unknown>;
    readonly artifacts?: Record<string, unknown>;
    readonly qmp?: Record<string, unknown>;
    readonly qga?: Record<string, unknown>;
  };
};

async function createLifecycleHarness(options: HarnessOptions = {}) {
  const root = await createTempDir();
  const config = parseCrucibleConfig({
    ...options.configInput,
    vm: { name: "life-test", ...options.configInput?.vm },
    artifacts: {
      directory: path.join(root, "artifacts"),
      manifestPath: path.join(root, "artifacts", "manifest.json"),
      logsDirectory: path.join(root, "artifacts", "logs"),
      snapshotsDirectory: path.join(root, "snapshots"),
      secretsDirectory: path.join(root, "secrets"),
      ...options.configInput?.artifacts,
    },
    qmp: {
      socketPath: path.join(root, "artifacts", "qmp.sock"),
      timeoutMs: 100,
      ...options.configInput?.qmp,
    },
    qga: { socketPath: path.join(root, "artifacts", "qga.sock"), ...options.configInput?.qga },
  });
  const plan = buildQemuCommandPlan({ config, ...options.plan });
  const paths = buildLifecyclePaths(config);
  const processes = new Set<number>();
  const spawnRequests: VmSpawnRequest[] = [];
  const signals: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }> = [];
  const harnessState = { deleteOnKill: true };
  const qmp = new FakeQmpSession(
    options.qmpConnectError,
    options.qmpConnectFailuresBeforeReady ?? 0,
    options.qmpAdvanceTimeOnConnectMs ?? 0,
    options.qmpQueryNeverResolves ?? false,
  );
  const qmpClientFactory: VmQmpClientFactory = () => qmp;
  const processController: VmProcessController = {
    isAlive: (pid) => processes.has(pid),
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGKILL" && harnessState.deleteOnKill) {
        processes.delete(pid);
      }
    },
    waitForExit: (pid) => Promise.resolve(!processes.has(pid)),
  };
  const manager = new VmLifecycleManager({
    config,
    plan,
    spawner: {
      spawn(request) {
        if (options.spawnError !== undefined) {
          return Promise.reject(options.spawnError);
        }
        spawnRequests.push(request);
        processes.add(4242);
        return Promise.resolve({ pid: 4242 });
      },
    },
    processController,
    qmpClientFactory,
    stopTimeoutMs: 1,
    killTimeoutMs: 1,
    pollIntervalMs: 1,
    startReadyTimeoutMs: 5,
    now: () => new Date("2026-05-27T00:00:00.000Z"),
  });

  return {
    config,
    get deleteOnKill() {
      return harnessState.deleteOnKill;
    },
    set deleteOnKill(value: boolean) {
      harnessState.deleteOnKill = value;
    },
    manager,
    paths,
    plan,
    processes,
    qmp,
    signals,
    spawnRequests,
  };
}

class FakeQmpSession implements VmQmpSession {
  readonly commands: string[] = [];
  readonly commandTimeouts: number[] = [];
  connects = 0;
  beforeNeverResolve: (() => void) | undefined;
  nextExecute: ((command: string) => { readonly returnValue: unknown }) | undefined;

  constructor(
    public connectError?: Error,
    private connectFailuresBeforeReady = 0,
    private advanceTimeOnConnectMs = 0,
    private queryNeverResolves = false,
  ) {}

  connect(): Promise<unknown> {
    this.connects += 1;
    if (this.advanceTimeOnConnectMs > 0) {
      const start = Date.now();
      while (Date.now() - start < this.advanceTimeOnConnectMs) {
        Date.now();
      }
    }
    if (this.connectFailuresBeforeReady > 0) {
      this.connectFailuresBeforeReady -= 1;
      return Promise.reject(new Error("qmp not ready"));
    }
    if (this.connectError !== undefined) {
      return Promise.reject(this.connectError);
    }
    return Promise.resolve({});
  }

  execute<T = unknown>(
    command: string,
    _args?: Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number },
  ): Promise<{ readonly returnValue: T }> {
    this.commands.push(command);
    if (options?.timeoutMs !== undefined) this.commandTimeouts.push(options.timeoutMs);
    if (this.queryNeverResolves) {
      this.beforeNeverResolve?.();
      return new Promise(() => undefined);
    }
    return Promise.resolve(
      (this.nextExecute?.(command) ?? { returnValue: {} }) as { readonly returnValue: T },
    );
  }

  close(): void {
    return undefined;
  }
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

async function mkdirFor(filePath: string): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(filePath), { recursive: true }),
  );
}

async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function errorDetails(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return undefined;
  }
  return error.details;
}
