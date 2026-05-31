import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLifecyclePaths,
  defaultCrucibleConfig,
  parseCrucibleConfig,
  type GuestAgentHealth,
  type VmStatus,
} from "@crucible/core";

import { runCrucibleCli } from "./index.js";

const defaultRuntime = { config: defaultCrucibleConfig };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("crucible CLI bootstrap", () => {
  it("prints help", async () => {
    const result = await runCrucibleCli(["--help"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("crucible provision");
    expect(result.stdout).toContain("crucible mcp");
  });

  it("prints media plan without manual links by default", async () => {
    const result = await runCrucibleCli(["media:plan"], defaultRuntime);

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
    const result = await runCrucibleCli(["media:plan", "--manual"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Windows 11 Enterprise Evaluation page");
    expect(result.stdout).toContain("stable virtio-win ISO");
    expect(result.stdout).toContain("Optional tool archives:");
    expect(result.stdout).toContain("Procdump.zip");
    expect(result.stdout).toContain("ProcessMonitor.zip");
    expect(result.stdout).not.toContain("Windows Server 2025 Evaluation page");
    expect(result.stdout).not.toContain("latest virtio-win ISO");
  });

  it("prints alternate Windows Server media plan", async () => {
    const result = await runCrucibleCli(
      ["media:plan", "--profile", "windows-server-2025-eval"],
      defaultRuntime,
    );

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

  it("prints network runtime status", async () => {
    const result = await runCrucibleCli(["net:status"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" }, network: { mode: "isolated" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network status: isolated");
    expect(result.stdout).toContain("guest egress: denied");
    expect(result.stdout).toContain("restart required to change mode: yes");
  });

  it("reports restart requirement for user-net mode changes", async () => {
    const result = await runCrucibleCli(["net:set", "nat"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" }, network: { mode: "isolated" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode change: isolated -> nat");
    expect(result.stdout).toContain("applied live: no");
    expect(result.stdout).toContain("restart required: yes");
    expect(result.stdout).toContain("restrict=off");
  });

  it("prints network teardown dry-run by default", async () => {
    const result = await runCrucibleCli(["net:teardown", "--mode", "capture"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network teardown dry-run:");
    expect(result.stdout).toContain("Owner: crucible/test-win/crucible-test-win-net0");
    expect(result.stdout).toContain("Missing resources: ignored");
    expect(result.stdout).toContain("Phase 2 print-only: no privileged host changes are executed.");
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
    expect(result.stdout).toContain("Phase 2 print-only: no privileged host changes are executed.");
    expect(result.stdout).toContain("Apply commands:");
    expect(result.stdout).toContain("iptables -D CRUCIBLE-CRUCIBLE-TEST-WIN-NET0");
    expect(result.stdout).toContain("ip link delete dev crucible-test-win-net0-tap");
    expect(result.stdout).not.toContain("iptables -X FORWARD");
  });

  it("rejects unknown network plan options", async () => {
    const result = await runCrucibleCli(["net:plan", "--backend", "pf"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown firewall backend: pf");
  });

  it("rejects unknown network teardown options", async () => {
    const result = await runCrucibleCli(["net:teardown", "--backend", "pf"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown firewall backend: pf");
  });

  it("rejects conflicting network teardown operation flags", async () => {
    const result = await runCrucibleCli(["net:teardown", "--dry-run", "--apply"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("net:teardown accepts only one of --dry-run or --apply");
  });

  it("prints alternate Windows Server manual-download instructions", async () => {
    const result = await runCrucibleCli(
      ["media:plan", "--manual", "--profile", "windows-server-2025-eval"],
      defaultRuntime,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Windows Server 2025 Evaluation page");
    expect(result.stdout).toContain("stable virtio-win ISO");
    expect(result.stdout).not.toContain("Windows 11 Enterprise Evaluation page");
    expect(result.stdout).not.toContain("latest virtio-win ISO");
  });

  it("fetches optional tool archives into the media cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-fetch-tools-"));
    const config = parseCrucibleConfig({ media: { cacheDir: path.join(root, "cache") } });
    const bodies = new Map<string, Buffer>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const body = Buffer.from(`payload:${url}`);
        bodies.set(url, body);
        return new Response(body, { status: 200 });
      }),
    );

    const result = await runCrucibleCli(["media:fetch-tools"], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sysinternals Suite: downloaded");
    expect(result.stdout).toContain("ProcDump: downloaded");
    expect(result.stdout).toContain("Process Monitor: downloaded");
    await expect(readFile(path.join(root, "cache", "Procdump.zip"), "utf8")).resolves.toContain(
      "Procdump.zip",
    );
    expect(bodies.size).toBe(3);
  });

  it("reuses cached tool archives unless forced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-fetch-tools-cached-"));
    const cacheDir = path.join(root, "cache");
    await mkdir(cacheDir, { recursive: true });
    for (const file of ["SysinternalsSuite.zip", "Procdump.zip", "ProcessMonitor.zip"]) {
      await writeFile(path.join(cacheDir, file), `cached:${file}`);
    }
    const config = parseCrucibleConfig({ media: { cacheDir } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCrucibleCli(["media:fetch-tools"], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ProcDump: cached");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => new Response(Buffer.from(`forced:${url}`), { status: 200 })),
    );
    const forced = await runCrucibleCli(["media:fetch-tools", "--force"], { config });
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("ProcDump: downloaded");
    await expect(readFile(path.join(cacheDir, "Procdump.zip"), "utf8")).resolves.toContain(
      "forced:",
    );
  });

  it("rejects unknown media profile", async () => {
    const result = await runCrucibleCli(["media:plan", "--profile", "windows-10"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown media profile: windows-10");
  });

  it("runs provision through fake lifecycle, stage, snapshot, and health contracts", async () => {
    const config = parseCrucibleConfig({
      vm: { name: "test-win" },
      analysisPolicy: {
        profile: {
          hostname: "DESKTOP-7F3K9Q2",
          username: "analyst",
          commonAnalysisLabCamouflage: true,
        },
      },
    });
    const progressEvents: string[] = [];
    const result = await runCrucibleCli(["provision"], {
      config,
      lifecycleManager: fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true }),
      provisioningExecutor: {
        runStage(stage) {
          return Promise.resolve({
            id: stage.id,
            title: stage.title,
            status: "succeeded",
            detail: stage.script?.scriptPath ?? "readiness contract",
          });
        },
      },
      snapshotManager: fakeSnapshotManager(config),
      skipBootKeyNudge: true,
      progress: {
        start: () => progressEvents.push("start"),
        stageStarted: (stage) => progressEvents.push(`start:${stage.id}`),
        stageCompleted: (stage) => progressEvents.push(`done:${stage.id}`),
        finish: (status) => progressEvents.push(`finish:${status}`),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Provisioning status: complete");
    expect(result.stdout).toContain("policy-configured: succeeded");
    expect(result.stdout).toContain("guest/provision/configure-policy.ps1");
    expect(result.stdout).toContain("Snapshot created: clean-base");
    expect(result.stdout).toContain("Guest health: degraded");
    expect(result.stdout).toContain("debugger-health: unknown");
    expect(progressEvents[0]).toBe("start");
    expect(progressEvents).toContain("start:media-ready");
    expect(progressEvents).toContain("done:snapshot-prepared");
    expect(progressEvents.at(-1)).toBe("finish:complete");
  });

  it("restarts into the final lifecycle after analysis tools stage", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const events: string[] = [];
    const setupLifecycle = fakeLifecycleManager(
      config,
      { processAlive: true, qmpAvailable: true },
      events,
      "setup",
    );
    const finalLifecycle = fakeLifecycleManager(
      config,
      { processAlive: true, qmpAvailable: true },
      events,
      "final",
    );
    const result = await runCrucibleCli(["provision"], {
      config,
      lifecycleManager: setupLifecycle,
      finalLifecycleManager: finalLifecycle,
      provisioningExecutor: {
        runStage(stage) {
          return Promise.resolve({
            id: stage.id,
            title: stage.title,
            status: "succeeded",
            detail: stage.script?.scriptPath ?? "readiness contract",
          });
        },
      },
      snapshotManager: fakeSnapshotManager(config),
      skipBootKeyNudge: true,
    });

    expect(result.exitCode).toBe(0);
    expect(events).toContain("setup:start");
    expect(events).toContain("setup:stop");
    expect(events).toContain("final:start");
    expect(events.at(-1)).toBe("final:status");
  });

  it("rejects unknown provision options", async () => {
    const result = await runCrucibleCli(["provision", "--apply"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown provision option: --apply");
  });

  it("reports a missing override guest agent binary before provisioning starts", async () => {
    const previous = process.env.CRUCIBLE_GUEST_AGENT_BINARY;
    const root = await mkdtemp(path.join(tmpdir(), "crucible-cli-"));
    process.env.CRUCIBLE_GUEST_AGENT_BINARY = path.join(root, "missing-agent.exe");
    const config = parseCrucibleConfig({
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
    });

    try {
      const result = await runCrucibleCli(["provision"], { config });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot find the Windows guest agent binary");
      expect(result.stderr).toContain("missing-agent.exe");
    } finally {
      if (previous === undefined) {
        delete process.env.CRUCIBLE_GUEST_AGENT_BINARY;
      } else {
        process.env.CRUCIBLE_GUEST_AGENT_BINARY = previous;
      }
    }
  });

  it("prints snapshot create and restore results", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const snapshotManager = fakeSnapshotManager(config);

    const create = await runCrucibleCli(["snapshot:create", "clean-base"], {
      config,
      snapshotManager,
    });
    const restore = await runCrucibleCli(["snapshot:restore", "clean-base"], {
      config,
      snapshotManager,
    });

    expect(create.exitCode).toBe(0);
    expect(create.stdout).toContain("Snapshot created: clean-base");
    expect(create.stdout).toContain("qmp commands: snapshot-save");
    expect(restore.exitCode).toBe(0);
    expect(restore.stdout).toContain("Snapshot restored: clean-base");
    expect(restore.stdout).toContain("qmp commands: snapshot-load");
  });

  it("reports guest health from lifecycle and provisioning contracts", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const result = await runCrucibleCli(["guest:health"], {
      config,
      lifecycleManager: fakeLifecycleManager(config, { processAlive: false, qmpAvailable: false }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Guest health: unavailable");
    expect(result.stdout).toContain("debugger-health: fail");
    expect(result.stdout).toContain("QMP is unavailable");
  });

  it("reports live guest health when a guest client is configured", async () => {
    const result = await runCrucibleCli(["guest:health"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () =>
            Promise.resolve({
              status: "ok",
              version: "test-version",
              hostName: "test-win",
              startedAt: "2026-05-29T00:00:00.000Z",
              uptimeSeconds: 42,
              goVersion: "go1.test",
              windbgInstalled: true,
              cdbPath: "C:\\Debuggers\\cdb.exe",
              windbgPath: "C:\\Debuggers\\windbg.exe",
            }),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from(
                JSON.stringify({
                  cdbPath: "C:\\Debuggers\\cdb.exe",
                  windbgPath: "C:\\Debuggers\\windbg.exe",
                  kdPath: "C:\\Debuggers\\kd.exe",
                  kdnetPath: "C:\\Debuggers\\kdnet.exe",
                  gflagsPath: "C:\\Debuggers\\gflags.exe",
                  symbolPath: "srv*C:\\symbols*https://msdl.microsoft.com/download/symbols",
                  symbolCachePath: "C:\\symbols",
                  symbolCacheWritable: true,
                  sysinternals: { handle: "C:\\Tools\\Sysinternals\\handle64.exe" },
                  crucibleAdminPresent: true,
                  crucibleUserPresent: true,
                  qemuAgentStatus: "Running",
                  crucibleAgentStatus: "Running",
                  defenderRealTimeProtectionEnabled: false,
                  codeIntegrityStateRecorded: true,
                  codeIntegrityEnforcementDisabled: true,
                  hypervisorEnforcedCodeIntegrityDisabled: true,
                  codeIntegrityBootOptions: [],
                  testSigningEnabled: false,
                  healthy: true,
                }),
              ).toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 10,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Guest health: healthy");
    expect(result.stdout).toContain("WinDbg installed: yes");
    expect(result.stdout).toContain("CDB path: C:\\Debuggers\\cdb.exe");
    expect(result.stdout).toContain("KD path: C:\\Debuggers\\kd.exe");
    expect(result.stdout).toContain("GFlags path: C:\\Debuggers\\gflags.exe");
    expect(result.stdout).toContain("symbol cache writable: yes");
    expect(result.stdout).toContain("Sysinternals: handle=C:\\Tools\\Sysinternals\\handle64.exe");
    expect(result.stdout).toContain("Defender real-time protection: no");
    expect(result.stdout).toContain("code-integrity state recorded: yes");
    expect(result.stdout).toContain("code-integrity enforcement disabled: yes");
    expect(result.stdout).toContain("test signing enabled: no");
  });

  it("renders live guest health as unhealthy when policy probe fails", async () => {
    const result = await runCrucibleCli(["guest:health"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () =>
            Promise.resolve({
              status: "ok",
              version: "test-version",
              hostName: "test-win",
              startedAt: "2026-05-29T00:00:00.000Z",
              uptimeSeconds: 42,
              goVersion: "go1.test",
              windbgInstalled: false,
            }),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from(
                JSON.stringify({
                  cdbPath: null,
                  windbgPath: null,
                  symbolPath: null,
                  crucibleAdminPresent: true,
                  crucibleUserPresent: true,
                  qemuAgentStatus: "Running",
                  crucibleAgentStatus: "Running",
                  defenderRealTimeProtectionEnabled: false,
                  codeIntegrityStateRecorded: true,
                  codeIntegrityEnforcementDisabled: true,
                  hypervisorEnforcedCodeIntegrityDisabled: true,
                  codeIntegrityBootOptions: [],
                  testSigningEnabled: false,
                  healthy: false,
                }),
              ).toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 10,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Guest health: unhealthy");
    expect(result.stdout).toContain("policy health: unhealthy");
  });

  it("executes guest commands through the service principal", async () => {
    const requests: Array<{ executable: string; arguments?: readonly string[]; as?: string }> = [];
    const guestClientFactory = () =>
      Promise.resolve({
        health: () => Promise.reject(new Error("unused")),
        exec: (request: { executable: string; arguments?: readonly string[]; as?: string }) => {
          requests.push(request);
          return Promise.resolve({
            exitCode: 0,
            stdoutBase64: Buffer.from(`ran ${request.executable}`).toString("base64"),
            stderrBase64: "",
            timedOut: false,
            durationMs: 7,
            truncated: false,
          });
        },
        close: () => Promise.resolve(),
      });
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });

    const defaultPrincipal = await runCrucibleCli(["guest:exec", "whoami.exe"], {
      config,
      guestClientFactory,
    });
    const explicitPrincipal = await runCrucibleCli(
      ["guest:exec", "--as", "admin", "whoami.exe", "/groups"],
      {
        config,
        guestClientFactory,
      },
    );

    expect(defaultPrincipal.exitCode).toBe(0);
    expect(explicitPrincipal.exitCode).toBe(0);
    expect(defaultPrincipal.stdout).toContain("stdout:\nran whoami.exe");
    expect(requests).toEqual([
      { executable: "whoami.exe", arguments: [], as: "service" },
      { executable: "whoami.exe", arguments: ["/groups"], as: "admin" },
    ]);
  });

  it("preserves arguments after a quoted guest command", async () => {
    const requests: Array<{ executable: string; arguments?: readonly string[]; as?: string }> = [];
    const result = await runCrucibleCli(["guest:exec", "whoami /groups", "--as", "admin"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.reject(new Error("unused")),
          exec: (request: { executable: string; arguments?: readonly string[]; as?: string }) => {
            requests.push(request);
            return Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from("ok").toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 1,
              truncated: false,
            });
          },
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([
      { executable: "cmd.exe", arguments: ["/d", "/s", "/c", "whoami /groups"], as: "admin" },
    ]);
  });

  it("preserves guest --as arguments after an explicit separator", async () => {
    const requests: Array<{ executable: string; arguments?: readonly string[]; as?: string }> = [];
    const result = await runCrucibleCli(["guest:exec", "tool.exe", "--", "--as", "admin"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.reject(new Error("unused")),
          exec: (request: { executable: string; arguments?: readonly string[]; as?: string }) => {
            requests.push(request);
            return Promise.resolve({
              exitCode: 0,
              stdoutBase64: "",
              stderrBase64: "",
              timedOut: false,
              durationMs: 1,
              truncated: false,
            });
          },
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([
      { executable: "tool.exe", arguments: ["--as", "admin"], as: "service" },
    ]);
  });

  it("runs debug:smoke through cdb on the guest client", async () => {
    const requests: Array<{ executable: string; arguments?: readonly string[]; as?: string }> = [];
    const result = await runCrucibleCli(
      ["debug:smoke", "--exe", "C:\\Windows\\System32\\notepad.exe"],
      {
        config: parseCrucibleConfig({ vm: { name: "test-win" } }),
        guestClientFactory: () =>
          Promise.resolve({
            health: () => Promise.resolve(guestHealth({ cdbPath: "C:\\Debuggers\\cdb.exe" })),
            exec: (request: { executable: string; arguments?: readonly string[]; as?: string }) => {
              requests.push(request);
              return Promise.resolve({
                exitCode: 0,
                stdoutBase64: Buffer.from("0:000> lm").toString("base64"),
                stderrBase64: "",
                timedOut: false,
                durationMs: 12,
                truncated: false,
              });
            },
            close: () => Promise.resolve(),
          }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("debug session:");
    expect(requests[0]).toMatchObject({ executable: "C:\\Debuggers\\cdb.exe", as: "service" });
    expect(requests[0]?.arguments).toContain("C:\\Windows\\System32\\notepad.exe");
  });

  it("falls back to cdb.exe for debug:smoke when health has no CDB path", async () => {
    const requests: Array<{ executable: string; arguments?: readonly string[]; as?: string }> = [];
    const result = await runCrucibleCli(["debug:smoke", "--exe", "notepad.exe"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: (request: { executable: string; arguments?: readonly string[]; as?: string }) => {
            requests.push(request);
            return Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from("0:000> lm").toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 12,
              truncated: false,
            });
          },
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(requests[0]).toMatchObject({ executable: "cdb.exe", as: "service" });
  });

  it("treats cdb exit code 1 as a successful smoke run", async () => {
    const result = await runCrucibleCli(["debug:smoke", "--exe", "notepad.exe"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 1,
              stdoutBase64: Buffer.from("symbol warning").toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 12,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exit code: 1");
  });

  it("prints the malware dry-run restore and collection order", async () => {
    const result = await runCrucibleCli(["scenario:malware-dry-run"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scenario: malware-dry-run");
    expect(result.stdout).toContain("restore snapshot: clean-base");
    expect(result.stdout).toContain("upload sample: dry-run");
    expect(result.stdout).toContain("execute sample: dry-run");
    expect(result.stdout).toContain("collect artifacts: dry-run");
    expect(result.stdout).toContain("Internet egress: denied by default");
  });

  it("runs the package release script through the process runner", async () => {
    const commands: string[] = [];
    const result = await runCrucibleCli(["package"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      processRunner: {
        run(command) {
          commands.push(`${command.executable} ${command.args.join(" ")}`);
          return Promise.resolve({
            command,
            exitCode: 0,
            stdout: '{"entries":[]}',
            stderr: "",
            durationMs: 1,
            timedOut: false,
            signal: null,
          });
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Package command: bash scripts/package-release.sh");
    expect(commands).toEqual(["bash scripts/package-release.sh"]);
  });

  it("returns non-zero when package command times out", async () => {
    const result = await runCrucibleCli(["package"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      processRunner: {
        run(command) {
          return Promise.resolve({
            command,
            exitCode: 0,
            stdout: "",
            stderr: "timed out",
            durationMs: 1,
            timedOut: true,
            signal: "SIGKILL",
          });
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("timed out");
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
      "user,id=crucible-test-win-net0,restrict=on,net=192.0.2.0/29,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
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
      "user,id=crucible-test-win-net0,restrict=off,net=192.0.2.0/29,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443",
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
    const result = await runCrucibleCli(["vm:stop", "--unknown", "--kill"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown vm:stop option: --unknown");
  });

  it("rejects extra vm:stop arguments after a valid option", async () => {
    const result = await runCrucibleCli(["vm:stop", "--kill", "--extra"], defaultRuntime);

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

  it("prints snapshot list from the artifact manifest", async () => {
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
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await writeFile(
      config.artifacts.manifestPath,
      JSON.stringify({
        version: 1,
        vmName: "test-win",
        artifacts: [
          {
            kind: "snapshot",
            name: "clean-base",
            path: path.join(root, "artifacts", "disks", "test-win.qcow2"),
            createdAt: "2026-05-27T00:00:00.000Z",
            baseDiskPath: path.join(root, "artifacts", "disks", "test-win.qcow2"),
            clean: true,
            mode: "offline-qcow2",
          },
        ],
      }),
      "utf8",
    );

    const result = await runCrucibleCli(["snapshot:list"], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Snapshots:");
    expect(result.stdout).toContain("clean-base: clean, offline-qcow2");
  });

  it("defaults snapshot commands to clean-base", async () => {
    const result = await runCrucibleCli(["snapshot:restore", "--flag"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("snapshot:restore accepts at most one snapshot name");
  });

  it("reports unsafe snapshot names as argument validation errors", async () => {
    const result = await runCrucibleCli(["snapshot:create", "../escape"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Snapshot names must be 1-64 characters");
  });
});

function fakeLifecycleManager(
  config: ReturnType<typeof parseCrucibleConfig>,
  options: { readonly processAlive: boolean; readonly qmpAvailable: boolean },
  events: string[] = [],
  label = "lifecycle",
) {
  const paths = buildLifecyclePaths(config);
  const status: VmStatus = {
    status: options.processAlive ? "running" : "stopped",
    processAlive: options.processAlive,
    qmpAvailable: options.qmpAvailable,
    qmpStatus: options.qmpAvailable ? "running" : undefined,
    paths,
    warnings: [],
  };

  return {
    paths,
    start: () => {
      events.push(`${label}:start`);
      return Promise.resolve({ pid: 1234, status });
    },
    stop: () => {
      events.push(`${label}:stop`);
      return Promise.resolve({
        status,
        mode: "stop" as const,
        qmpCommandSent: true,
        killedAfterTimeout: false,
      });
    },
    poweroff: () =>
      Promise.resolve({
        status,
        mode: "poweroff" as const,
        qmpCommandSent: true,
        killedAfterTimeout: false,
      }),
    kill: () =>
      Promise.resolve({
        status,
        mode: "stop" as const,
        qmpCommandSent: false,
        killedAfterTimeout: true,
      }),
    status: () => {
      events.push(`${label}:status`);
      return Promise.resolve(status);
    },
  };
}

function fakeSnapshotManager(config: ReturnType<typeof parseCrucibleConfig>) {
  return {
    create: (snapshotName: string) =>
      Promise.resolve(fakeSnapshotCreateResult(config, snapshotName)),
    list: () => Promise.resolve([]),
    restore: (snapshotName: string) =>
      Promise.resolve({
        ...fakeSnapshotCreateResult(config, snapshotName),
        restoredAt: "2026-05-27T00:00:00.000Z",
        qmpCommands: ["snapshot-load"],
      }),
  };
}

function fakeSnapshotCreateResult(
  config: ReturnType<typeof parseCrucibleConfig>,
  snapshotName: string,
) {
  const diskPath = path.join(config.artifacts.directory, "disks", `${config.vm.name}.qcow2`);

  return {
    snapshot: {
      kind: "snapshot" as const,
      name: snapshotName,
      path: diskPath,
      createdAt: "2026-05-27T00:00:00.000Z",
      baseDiskPath: diskPath,
      clean: snapshotName === "clean-base",
      qemuTag: snapshotName,
      mode: "online-qmp" as const,
    },
    qmpCommands: ["snapshot-save"],
    qcow2Commands: [],
  };
}

function guestHealth(overrides: Partial<GuestAgentHealth> = {}): GuestAgentHealth {
  return {
    status: "ok",
    version: "test-version",
    hostName: "test-win",
    startedAt: "2026-05-31T00:00:00.000Z",
    uptimeSeconds: 1,
    goVersion: "go1.test",
    windbgInstalled: true,
    ...overrides,
  };
}
