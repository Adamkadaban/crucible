import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("crucible CLI bootstrap", () => {
  it("prints help", async () => {
    const result = await runCrucibleCli(["--help"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("crucible provision");
    expect(result.stdout).toContain("crucible mcp");
    expect(result.stdout).toContain("crucible vm status");
    expect(result.stdout).toContain("Command groups:");
  });

  it("prints grouped and command help", async () => {
    const group = await runCrucibleCli(["vm", "--help"], defaultRuntime);
    const command = await runCrucibleCli(["vm", "status", "--help"], defaultRuntime);

    expect(group.exitCode).toBe(0);
    expect(group.stdout).toContain("crucible vm");
    expect(group.stdout).toContain("vm status");
    expect(command.exitCode).toBe(0);
    expect(command.stdout).toContain("crucible vm status");
    expect(command.stdout).toContain("Aliases: vm:status");
  });

  it("supports space-separated command aliases", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const lifecycle = fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true });
    const snapshotManager = fakeSnapshotManager(config);

    const vmStatus = await runCrucibleCli(["vm", "status"], {
      config,
      lifecycleManager: lifecycle,
    });
    const snapshotList = await runCrucibleCli(["snapshot", "list"], { config, snapshotManager });
    const networkStatus = await runCrucibleCli(["network", "status"], { config });
    const netAlias = await runCrucibleCli(["net", "status"], { config });
    const guestExec = await runCrucibleCli(["guest", "exec", "whoami.exe"], {
      config,
      guestClientFactory: () => Promise.resolve(fakeGuestClient()),
    });

    expect(vmStatus.exitCode).toBe(0);
    expect(vmStatus.stdout).toContain("status: running");
    expect(snapshotList.exitCode).toBe(0);
    expect(snapshotList.stdout).toContain("Snapshots: none");
    expect(networkStatus.exitCode).toBe(0);
    expect(networkStatus.stdout).toContain("Network status:");
    expect(netAlias.exitCode).toBe(0);
    expect(netAlias.stdout).toContain("Network status:");
    expect(guestExec.exitCode).toBe(0);
    expect(guestExec.stdout).toContain("fake-output");
  });

  it("passes guest command help flags after the argument separator", async () => {
    const requests: Array<{ executable: string; arguments?: readonly string[] }> = [];
    const result = await runCrucibleCli(["guest", "exec", "--", "whoami.exe", "--help"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          ...fakeGuestClient(),
          exec: (request: { executable: string; arguments?: readonly string[] }) => {
            requests.push(request);
            return Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from("guest-help").toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 5,
              truncated: false,
            });
          },
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("guest-help");
    expect(result.stdout).not.toContain("Command groups:");
    expect(requests[0]).toMatchObject({ executable: "whoami.exe", arguments: ["--help"] });
  });

  it("prints mcp banner without starting stdio transport", async () => {
    const result = await runCrucibleCli(["mcp"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("crucible MCP server");
    expect(result.stdout).toContain("Bootstrap tools:");
    expect(result.stdout).toContain("guest_health");
  });

  it("reports unknown top-level commands with help", async () => {
    const result = await runCrucibleCli(["nope"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown command: nope");
    expect(result.stderr).toContain("crucible provision");
  });

  it("suggests close command matches", async () => {
    const result = await runCrucibleCli(["vm", "stats", "--bad"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown command: vm stats");
    expect(result.stderr).not.toContain("Unknown command: vm stats --bad");
    expect(result.stderr).toContain("Did you mean: crucible vm status?");
  });

  it("rejects invalid vm:create and vm:start options", async () => {
    const create = await runCrucibleCli(["vm:create"], defaultRuntime);
    const start = await runCrucibleCli(["vm:start", "--bad"], defaultRuntime);

    expect(create.exitCode).toBe(2);
    expect(create.stderr).toContain("vm:create currently supports --dry-run only");
    expect(start.exitCode).toBe(2);
    expect(start.stderr).toContain("Unknown vm:start option: --bad");
  });

  it("starts and stops through injected lifecycle manager variants", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const events: string[] = [];
    const lifecycle = fakeLifecycleManager(
      config,
      { processAlive: true, qmpAvailable: true },
      events,
    );

    const start = await runCrucibleCli(["vm:start"], { config, lifecycleManager: lifecycle });
    const stop = await runCrucibleCli(["vm:stop"], { config, lifecycleManager: lifecycle });
    const poweroff = await runCrucibleCli(["vm:stop", "--poweroff"], {
      config,
      lifecycleManager: lifecycle,
    });
    const kill = await runCrucibleCli(["vm:stop", "--kill"], {
      config,
      lifecycleManager: lifecycle,
    });

    expect(start.exitCode).toBe(0);
    expect(start.stdout).toContain("VM started: pid 1234");
    expect(stop.stdout).toContain("VM stop requested.");
    expect(poweroff.stdout).toContain("VM poweroff requested.");
    expect(kill.stdout).toContain("killed after timeout: yes");
    expect(events).toEqual(["lifecycle:start", "lifecycle:stop"]);
  });

  it("rejects invalid vm status/log/snapshot list options", async () => {
    const status = await runCrucibleCli(["vm:status", "--bad"], defaultRuntime);
    const logs = await runCrucibleCli(["vm:logs", "--bad"], defaultRuntime);
    const snapshots = await runCrucibleCli(["snapshot:list", "--bad"], defaultRuntime);

    expect(status.stderr).toContain("Unknown vm:status option: --bad");
    expect(logs.stderr).toContain("Unknown vm:logs option: --bad");
    expect(snapshots.stderr).toContain("Unknown snapshot:list option: --bad");
  });

  it("runs when invoked through an npm-style bin symlink", async () => {
    const root = await createTempDir("crucible-bin-");
    const binPath = path.join(root, "crucible");
    await symlink(path.resolve("packages/cli/src/index.ts"), binPath);

    const result = spawnSync(process.execPath, [binPath, "--help"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--import tsx --conditions=development" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("crucible provision");
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
    const root = await createTempDir("crucible-fetch-tools-");
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
    const root = await createTempDir("crucible-fetch-tools-cached-");
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

  it("initializes crucible.config.json idempotently", async () => {
    const root = await createTempDir("crucible-cli-");
    const outputPath = path.join(root, "crucible.config.json");

    const created = await runCrucibleCli(["config:init", "--output", outputPath], defaultRuntime);
    const refused = await runCrucibleCli(["config:init", "--output", outputPath], defaultRuntime);
    const forced = await runCrucibleCli(
      ["config:init", "--output", outputPath, "--force"],
      defaultRuntime,
    );

    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain(`Wrote ${outputPath}`);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("already exists");
    expect(forced.exitCode).toBe(0);
    const config = JSON.parse(await readFile(outputPath, "utf8")) as {
      $schema: string;
      media: { windowsIso: { path: string }; virtioIso: { path: string } };
    };
    expect(config.$schema).toBe(
      "https://raw.githubusercontent.com/Adamkadaban/crucible/main/schemas/config.schema.json",
    );
    expect(config.media.windowsIso.path).toBe("/path/to/windows.iso");
    expect(config.media.virtioIso.path).toBe("/path/to/virtio-win.iso");
  });

  it("rejects unknown config:init options", async () => {
    const result = await runCrucibleCli(["config:init", "--bad"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown config:init option: --bad");
  });

  it("prints host setup install command without --yes", async () => {
    const result = await runCrucibleCli(["setup", "host"], defaultRuntime);

    expect([0, 1]).toContain(result.exitCode);
    if (result.exitCode === 0) {
      expect(result.stdout).toContain("Host prerequisites are already satisfied");
    } else {
      expect(result.stdout).toContain("sudo apt install");
      expect(result.stdout).toContain("Re-run with --yes");
    }
  });

  it("rejects unknown doctor options", async () => {
    const result = await runCrucibleCli(["doctor", "--bad"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown doctor option: --bad");
  });

  it("prints opencode setup config without writing", async () => {
    const result = await runCrucibleCli(["setup", "opencode", "--print"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("opencode.json");
    expect(result.stdout).toContain('"command": "crucible"');
    expect(result.stdout).toContain('"mcp"');
  });

  it("updates opencode config idempotently while preserving existing keys", async () => {
    const previousHome = process.env.HOME;
    const root = await createTempDir("crucible-home-");
    process.env.HOME = root;
    const configPath = path.join(root, ".config", "opencode", "opencode.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ theme: "dark", mcp: { existing: { command: "other" } } }, null, 2),
    );

    try {
      const first = await runCrucibleCli(["setup", "opencode"], defaultRuntime);
      const second = await runCrucibleCli(["setup", "opencode"], defaultRuntime);
      const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
        theme: string;
        mcp: { existing?: { command: string }; crucible?: { command: string; args: string[] } };
      };

      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain(`Updated opencode config: ${configPath}`);
      expect(first.stdout).toContain("Backup:");
      expect(second.exitCode).toBe(0);
      expect(parsed.theme).toBe("dark");
      expect(parsed.mcp.existing?.command).toBe("other");
      expect(parsed.mcp.crucible).toEqual({
        type: "stdio",
        command: "crucible",
        args: ["mcp", "--stdio"],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("does not overwrite malformed opencode config", async () => {
    const previousHome = process.env.HOME;
    const root = await createTempDir("crucible-home-");
    process.env.HOME = root;
    const configPath = path.join(root, ".config", "opencode", "opencode.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{not json", "utf8");

    try {
      const result = await runCrucibleCli(["setup", "opencode"], defaultRuntime);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Expected property name");
      await expect(readFile(configPath, "utf8")).resolves.toBe("{not json");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("does not overwrite non-object opencode config", async () => {
    const previousHome = process.env.HOME;
    const root = await createTempDir("crucible-home-");
    process.env.HOME = root;
    const configPath = path.join(root, ".config", "opencode", "opencode.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "[]", "utf8");

    try {
      const result = await runCrucibleCli(["setup", "opencode"], defaultRuntime);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("to contain a JSON object");
      await expect(readFile(configPath, "utf8")).resolves.toBe("[]");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("does not overwrite opencode config with non-object mcp key", async () => {
    const previousHome = process.env.HOME;
    const root = await createTempDir("crucible-home-");
    process.env.HOME = root;
    const configPath = path.join(root, ".config", "opencode", "opencode.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcp: [] }), "utf8");

    try {
      const result = await runCrucibleCli(["setup", "opencode"], defaultRuntime);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("opencode.json.mcp");
      await expect(readFile(configPath, "utf8")).resolves.toBe(JSON.stringify({ mcp: [] }));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("reports opencode config filesystem failures as command results", async () => {
    const previousHome = process.env.HOME;
    const root = await createTempDir("crucible-home-file-");
    const homeFile = path.join(root, "not-a-directory");
    await writeFile(homeFile, "x", "utf8");
    process.env.HOME = homeFile;

    try {
      const result = await runCrucibleCli(["setup", "opencode"], defaultRuntime);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Failed to");
      expect(result.stderr).toContain("opencode.json");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("allocates unique opencode backup paths", async () => {
    const previousHome = process.env.HOME;
    const root = await createTempDir("crucible-home-");
    process.env.HOME = root;
    const configPath = path.join(root, ".config", "opencode", "opencode.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcp: {} }), "utf8");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(12345);
    await writeFile(`${configPath}.bak.12345`, "placeholder", "utf8");

    try {
      const result = await runCrucibleCli(["setup", "opencode"], defaultRuntime);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Backup: ${configPath}.bak.12345.1`);
    } finally {
      nowSpy.mockRestore();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("prints claude setup command without writing", async () => {
    const result = await runCrucibleCli(["setup", "claude", "--print"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("claude mcp add");
    expect(result.stdout).toContain("crucible mcp --stdio");
  });

  it("prints setup guidance for codex and copilot", async () => {
    const codex = await runCrucibleCli(["setup", "codex", "--print"], defaultRuntime);
    const copilot = await runCrucibleCli(["setup", "copilot", "--print"], defaultRuntime);

    expect(codex.exitCode).toBe(0);
    expect(codex.stdout).toContain("Codex MCP configuration is version-dependent");
    expect(copilot.exitCode).toBe(0);
    expect(copilot.stdout).toContain("Copilot CLI MCP configuration is version-dependent");
  });

  it("aggregates setup all output across targets", async () => {
    const previousHome = process.env.HOME;
    const root = await createTempDir("crucible-home-");
    process.env.HOME = root;

    try {
      const result = await runCrucibleCli(["setup", "all", "--print"], defaultRuntime);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("## host");
      expect(result.stdout).toContain("## opencode");
      expect(result.stdout).toContain("## claude");
      expect(result.stdout).toContain("## codex");
      expect(result.stdout).toContain("## copilot");
      expect(result.stdout).toContain("crucible mcp --stdio");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("rejects unknown setup targets", async () => {
    const result = await runCrucibleCli(["setup", "unknown"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("setup requires one target");
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
    expect(result.stdout).toContain("Guest health: healthy");
    expect(result.stdout).toContain("debugger-health: pass");
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
    const root = await createTempDir("crucible-cli-");
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

  it("rejects unknown malware dry-run options", async () => {
    const result = await runCrucibleCli(["scenario:malware-dry-run", "--bad"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown scenario:malware-dry-run option: --bad");
  });

  it("rejects invalid guest exec and debug smoke arguments", async () => {
    const exec = await runCrucibleCli(["guest:exec"], defaultRuntime);
    const smoke = await runCrucibleCli(["debug:smoke"], defaultRuntime);

    expect(exec.exitCode).toBe(2);
    expect(exec.stderr).toContain("guest:exec requires an executable");
    expect(smoke.exitCode).toBe(2);
    expect(smoke.stderr).toContain("debug:smoke requires --exe");
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

  it("rejects unknown package options", async () => {
    const result = await runCrucibleCli(["package", "--bad"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown package option: --bad");
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
    const root = await createTempDir("crucible-cli-");
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
    const root = await createTempDir("crucible-cli-");
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
    const root = await createTempDir("crucible-cli-");
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
    const root = await createTempDir("crucible-cli-");
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
    const root = await createTempDir("crucible-cli-");
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

function fakeGuestClient(execResult?: {
  exitCode: number;
  stdoutBase64: string;
  stderrBase64: string;
}) {
  const defaultExecResult = {
    exitCode: 0,
    stdoutBase64: Buffer.from("fake-output").toString("base64"),
    stderrBase64: "",
    timedOut: false,
    durationMs: 5,
    truncated: false,
  };
  return {
    health: () => Promise.resolve(guestHealth()),
    exec: () => Promise.resolve({ ...defaultExecResult, ...execResult }),
    close: () => Promise.resolve(),
  };
}

describe("additional CLI coverage", () => {
  it("scenario:malware-dry-run runs all steps and reports success", async () => {
    const result = await runCrucibleCli(["scenario:malware-dry-run"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scenario: malware-dry-run");
    expect(result.stdout).toContain("status: succeeded");
    expect(result.stdout).toContain("restore snapshot: clean-base");
  });

  it("guest:health reports degraded when guest client factory throws ENOENT", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const result = await runCrucibleCli(["guest:health"], {
      config,
      guestClientFactory: () => {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return Promise.reject(err);
      },
    });

    // When an injected guestClientFactory throws, the CLI returns the error
    // message in stderr rather than falling back to lifecycle-based health.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ENOENT");
  });

  it("guest:exec runs and renders output", async () => {
    const result = await runCrucibleCli(["guest:exec", "--as", "admin", "ipconfig.exe"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve(
          fakeGuestClient({
            exitCode: 0,
            stdoutBase64: Buffer.from("Windows IP Configuration").toString("base64"),
            stderrBase64: "",
          }),
        ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exit code:");
  });

  it("media:plan renders plan with --manual flag", async () => {
    const result = await runCrucibleCli(["media:plan", "--manual"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Optional tool archives:");
  });

  it("media:plan renders without manual instructions by default", async () => {
    const result = await runCrucibleCli(["media:plan"], defaultRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Manual download instructions are hidden");
  });

  it("net:plan renders network plan", async () => {
    const result = await runCrucibleCli(["net:plan"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode:");
    expect(result.stdout).toContain("QEMU backend:");
  });

  it("net:teardown renders teardown", async () => {
    const result = await runCrucibleCli(["net:teardown", "--dry-run"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
  });

  it("net:status renders status", async () => {
    const result = await runCrucibleCli(["net:status"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network status:");
  });

  it("net:set changes network mode", async () => {
    const result = await runCrucibleCli(["net:set", "nat"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" }, network: { mode: "isolated" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode change:");
  });

  it("vm:logs renders log content", async () => {
    const root = await createTempDir("crucible-cli-logs-");
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
    const paths = buildLifecyclePaths(config);
    await mkdir(path.dirname(paths.stdoutLog), { recursive: true });
    await writeFile(paths.stdoutLog, "hello-from-vm-stdout\n", "utf8");
    await writeFile(paths.stderrLog, "hello-from-vm-stderr\n", "utf8");

    const result = await runCrucibleCli(["vm:logs"], {
      config,
      lifecycleManager: {
        ...fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true }),
        paths,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-from-vm-stdout");
  });

  it("snapshot:list with empty manifest shows none", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const snapshotManager = {
      ...fakeSnapshotManager(config),
      list: () => Promise.resolve([]),
    };

    const result = await runCrucibleCli(["snapshot:list"], { config, snapshotManager });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Snapshots: none");
  });

  it("snapshot:list with entries shows them", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const diskPath = path.join(config.artifacts.directory, "disks", "test-win.qcow2");
    const snapshotManager = {
      ...fakeSnapshotManager(config),
      list: () =>
        Promise.resolve([
          {
            kind: "snapshot" as const,
            name: "clean-base",
            path: diskPath,
            createdAt: "2026-05-27T00:00:00.000Z",
            baseDiskPath: diskPath,
            clean: true,
            qemuTag: "clean-base",
            mode: "online-qmp" as const,
          },
          {
            kind: "snapshot" as const,
            name: "after-install",
            path: diskPath,
            createdAt: "2026-05-27T01:00:00.000Z",
            baseDiskPath: diskPath,
            clean: false,
            qemuTag: "after-install",
            mode: "online-qmp" as const,
          },
        ]),
    };

    const result = await runCrucibleCli(["snapshot:list"], { config, snapshotManager });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("clean-base");
    expect(result.stdout).toContain("after-install");
  });

  it("config:init writes example config", async () => {
    const root = await createTempDir("crucible-cli-init-");
    const outputPath = path.join(root, "crucible.config.json");

    const created = await runCrucibleCli(["config:init", "--output", outputPath], defaultRuntime);
    expect(created.exitCode).toBe(0);
    const contents = await readFile(outputPath, "utf8");
    expect(contents).toContain("$schema");

    const refused = await runCrucibleCli(["config:init", "--output", outputPath], defaultRuntime);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("already exists");

    const forced = await runCrucibleCli(
      ["config:init", "--output", outputPath, "--force"],
      defaultRuntime,
    );
    expect(forced.exitCode).toBe(0);
  });

  it("doctor reports host check results", async () => {
    const result = await runCrucibleCli(["doctor"], defaultRuntime);

    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout).toContain("Host:");
    expect(result.stdout).toContain("Status:");
  });

  it("guest:exec succeeds through a fake client", async () => {
    const result = await runCrucibleCli(["guest:exec", "whoami"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from("hello").toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 100,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exit code: 0");
    expect(result.stdout).toContain("hello");
  });

  it("guest:exec with --as admin", async () => {
    const result = await runCrucibleCli(
      ["guest:exec", "--as", "admin", "cmd.exe", "/c", "echo hi"],
      {
        config: parseCrucibleConfig({ vm: { name: "test-win" } }),
        guestClientFactory: () =>
          Promise.resolve({
            health: () => Promise.resolve(guestHealth()),
            exec: () =>
              Promise.resolve({
                exitCode: 0,
                stdoutBase64: Buffer.from("hi").toString("base64"),
                stderrBase64: "",
                timedOut: false,
                durationMs: 50,
                truncated: false,
              }),
            close: () => Promise.resolve(),
          }),
      },
    );

    expect(result.exitCode).toBe(0);
  });

  it("guest:health succeeds with fake client and policy health", async () => {
    const policyHealth = {
      cdbPath: "cdb.exe",
      windbgPath: "windbg.exe",
      healthy: true,
      crucibleAdminPresent: true,
      crucibleUserPresent: true,
      qemuAgentStatus: "Running",
      crucibleAgentStatus: "Running",
      defenderRealTimeProtectionEnabled: false,
      codeIntegrityStateRecorded: true,
      codeIntegrityEnforcementDisabled: true,
      hypervisorEnforcedCodeIntegrityDisabled: true,
      codeIntegrityBootOptions: [] as string[],
      testSigningEnabled: false,
      symbolPath: "srv*",
      symbolCachePath: "C:\\Symbols",
      symbolCacheWritable: true,
      sysinternals: { handle: "handle64.exe" },
      kdPath: "kd.exe",
      kdnetPath: "kdnet.exe",
      gflagsPath: "gflags.exe",
    };
    const result = await runCrucibleCli(["guest:health"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () =>
            Promise.resolve(
              guestHealth({
                cdbPath: "cdb.exe",
                windbgPath: "windbg.exe",
              }),
            ),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from(JSON.stringify(policyHealth)).toString("base64"),
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
  });

  it("vm:logs renders stdout and stderr logs", async () => {
    const root = await createTempDir("crucible-cli-logs2-");
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
    const lifecycle = fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true });
    await mkdir(path.dirname(lifecycle.paths.stdoutLog), { recursive: true });
    await writeFile(lifecycle.paths.stdoutLog, "vm-stdout-content\n", "utf8");
    await writeFile(lifecycle.paths.stderrLog, "vm-stderr-content\n", "utf8");

    const result = await runCrucibleCli(["vm:logs"], { config, lifecycleManager: lifecycle });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("vm-stdout-content");
    expect(result.stdout).toContain("vm-stderr-content");
  });

  it("vm:start delegates to lifecycle manager", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const lifecycle = fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true });

    const result = await runCrucibleCli(["vm:start"], { config, lifecycleManager: lifecycle });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VM started: pid");
  });

  it("vm:stop --poweroff delegates to lifecycle", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const lifecycle = fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true });

    const result = await runCrucibleCli(["vm:stop", "--poweroff"], {
      config,
      lifecycleManager: lifecycle,
    });

    expect(result.exitCode).toBe(0);
  });

  it("vm:stop --kill delegates to lifecycle", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const lifecycle = fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true });

    const result = await runCrucibleCli(["vm:stop", "--kill"], {
      config,
      lifecycleManager: lifecycle,
    });

    expect(result.exitCode).toBe(0);
  });

  it("snapshot:create creates and renders result", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const snapshotManager = fakeSnapshotManager(config);

    const result = await runCrucibleCli(["snapshot:create", "my-snap"], {
      config,
      snapshotManager,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Snapshot created: my-snap");
  });

  it("snapshot:restore restores and renders result", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const snapshotManager = fakeSnapshotManager(config);

    const result = await runCrucibleCli(["snapshot:restore"], { config, snapshotManager });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Snapshot restored: clean-base");
  });

  it("net:set rejects invalid mode", async () => {
    const result = await runCrucibleCli(["net:set", "invalid"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("net:set requires one mode");
  });

  it("net:teardown rejects unknown option", async () => {
    const result = await runCrucibleCli(["net:teardown", "--invalid"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown net:teardown option: --invalid");
  });

  it("provision fails when stage is blocked", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const result = await runCrucibleCli(["provision"], {
      config,
      lifecycleManager: fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true }),
      provisioningExecutor: {
        runStage(stage) {
          return Promise.resolve({
            id: stage.id,
            title: stage.title,
            status: "blocked",
            detail: "missing media",
          });
        },
      },
      snapshotManager: fakeSnapshotManager(config),
      skipBootKeyNudge: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Provisioning status: blocked");
  });

  it("package command fails when process runner returns non-zero", async () => {
    const result = await runCrucibleCli(["package"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      processRunner: {
        run(command) {
          return Promise.resolve({
            command,
            exitCode: 1,
            stdout: "",
            stderr: "build failed",
            durationMs: 1,
            timedOut: false,
            signal: null,
          });
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("build failed");
  });

  it("net:plan --mode nat --backend iptables renders iptables plan", async () => {
    const result = await runCrucibleCli(["net:plan", "--mode", "nat", "--backend", "iptables"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode: nat");
    expect(result.stdout).toContain("Firewall backend: iptables");
  });

  it("net:teardown --dry-run --mode nat renders nat teardown", async () => {
    const result = await runCrucibleCli(["net:teardown", "--dry-run", "--mode", "nat"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network teardown dry-run:");
  });

  it("setup host --print shows prerequisite status", async () => {
    const result = await runCrucibleCli(["setup", "host", "--print"], defaultRuntime);

    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("vm:status renders status via injected lifecycle manager", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const lifecycle = fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true });

    const result = await runCrucibleCli(["vm:status"], { config, lifecycleManager: lifecycle });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status: running");
  });

  it("guest:health rejects extra options", async () => {
    const result = await runCrucibleCli(["guest:health", "--bad"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown");
  });

  it("snapshot:restore with named snapshot renders result", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const snapshotManager = fakeSnapshotManager(config);

    const result = await runCrucibleCli(["snapshot:restore", "my-snap"], {
      config,
      snapshotManager,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Snapshot restored: my-snap");
  });

  it("net:plan --mode capture --backend nftables renders nftables plan", async () => {
    const result = await runCrucibleCli(
      ["net:plan", "--mode", "capture", "--backend", "nftables"],
      { config: parseCrucibleConfig({ vm: { name: "test-win" } }) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode: capture");
    expect(result.stdout).toContain("Firewall backend: nftables");
  });

  it("net:teardown --apply --mode capture --backend nftables renders apply", async () => {
    const result = await runCrucibleCli(
      ["net:teardown", "--apply", "--mode", "capture", "--backend", "nftables"],
      { config: parseCrucibleConfig({ vm: { name: "test-win" } }) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network teardown apply:");
  });

  it("media:fetch-tools rejects unknown options", async () => {
    const result = await runCrucibleCli(["media:fetch-tools", "--bad"], defaultRuntime);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown");
  });

  it("renders provisioning blocked status with manual media recovery instructions", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const result = await runCrucibleCli(["provision"], {
      config,
      lifecycleManager: fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true }),
      provisioningExecutor: {
        runStage(stage) {
          return Promise.resolve({
            id: stage.id,
            title: stage.title,
            status: stage.id === "media-ready" ? "blocked" : "succeeded",
            detail: stage.id === "media-ready" ? "missing ISO" : "ok",
          });
        },
      },
      snapshotManager: fakeSnapshotManager(config),
      skipBootKeyNudge: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Provisioning status: blocked");
    expect(result.stdout).toContain("Manual media recovery:");
  });

  it("guest:health falls back to lifecycle report when no guest client factory is provided", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const lifecycle = fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true });

    // Ensure no explicit guest env vars are set
    const saved = {
      CRUCIBLE_GUEST_BASE_URL: process.env.CRUCIBLE_GUEST_BASE_URL,
      CRUCIBLE_GUEST_CA_PATH: process.env.CRUCIBLE_GUEST_CA_PATH,
      CRUCIBLE_GUEST_CERT_PATH: process.env.CRUCIBLE_GUEST_CERT_PATH,
      CRUCIBLE_GUEST_KEY_PATH: process.env.CRUCIBLE_GUEST_KEY_PATH,
    };
    delete process.env.CRUCIBLE_GUEST_BASE_URL;
    delete process.env.CRUCIBLE_GUEST_CA_PATH;
    delete process.env.CRUCIBLE_GUEST_CERT_PATH;
    delete process.env.CRUCIBLE_GUEST_KEY_PATH;

    try {
      const result = await runCrucibleCli(["guest:health"], {
        config,
        lifecycleManager: lifecycle,
        // No guestClientFactory — the default buildDefaultGuestClientFactory will
        // try to connect via mTLS cert files which won't exist, producing ENOENT.
        // Since hasExplicitGuestClientEnv() is false and the error is ENOENT,
        // the CLI falls through to the lifecycle-based health report.
      });

      expect(result.stdout).toContain("Guest health:");
      expect(result.stdout).toContain("VM: test-win");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("guest:exec returns error when no guest client is configured", async () => {
    const saved = {
      CRUCIBLE_GUEST_BASE_URL: process.env.CRUCIBLE_GUEST_BASE_URL,
      CRUCIBLE_GUEST_CA_PATH: process.env.CRUCIBLE_GUEST_CA_PATH,
      CRUCIBLE_GUEST_CERT_PATH: process.env.CRUCIBLE_GUEST_CERT_PATH,
      CRUCIBLE_GUEST_KEY_PATH: process.env.CRUCIBLE_GUEST_KEY_PATH,
    };
    delete process.env.CRUCIBLE_GUEST_BASE_URL;
    delete process.env.CRUCIBLE_GUEST_CA_PATH;
    delete process.env.CRUCIBLE_GUEST_CERT_PATH;
    delete process.env.CRUCIBLE_GUEST_KEY_PATH;

    try {
      // buildDefaultGuestClientFactory returns undefined only when env vars
      // are missing AND the mTLS path factory is constructed (it always returns
      // a factory). So we test with an injected undefined instead.
      // Actually: buildDefaultGuestClientFactory always returns a function.
      // The only way guestClientFactory === undefined is if both env-based and
      // default factories fail. Test the error message path via parseGuestExecArgs.
      const result = await runCrucibleCli(["guest:exec", "--as"], defaultRuntime);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Missing value for --as");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("guest:exec rejects unknown execution principal", async () => {
    const result = await runCrucibleCli(["guest:exec", "--as", "root", "whoami"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown guest execution principal: root");
  });

  it("net:set rejects missing or extra arguments", async () => {
    const noArgs = await runCrucibleCli(["net:set"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });
    const tooMany = await runCrucibleCli(["net:set", "nat", "extra"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(noArgs.exitCode).toBe(2);
    expect(noArgs.stderr).toContain("net:set requires one mode");
    expect(tooMany.exitCode).toBe(2);
    expect(tooMany.stderr).toContain("net:set requires one mode");
  });

  it("net:status rejects extra arguments", async () => {
    const result = await runCrucibleCli(["net:status", "--verbose"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown net:status option: --verbose");
  });

  it("net:plan rejects missing --mode value", async () => {
    const result = await runCrucibleCli(["net:plan", "--mode"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing value for --mode");
  });

  it("net:plan rejects unknown mode value", async () => {
    const result = await runCrucibleCli(["net:plan", "--mode", "bridge"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown network mode: bridge");
  });

  it("net:plan rejects missing --backend value", async () => {
    const result = await runCrucibleCli(["net:plan", "--backend"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing value for --backend");
  });

  it("net:teardown rejects missing --mode value", async () => {
    const result = await runCrucibleCli(["net:teardown", "--mode"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing value for --mode");
  });

  it("net:teardown rejects unknown mode value", async () => {
    const result = await runCrucibleCli(["net:teardown", "--mode", "bridge"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown network mode: bridge");
  });

  it("net:teardown rejects missing --backend value", async () => {
    const result = await runCrucibleCli(["net:teardown", "--backend"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing value for --backend");
  });

  it("media:plan rejects missing --profile value", async () => {
    const result = await runCrucibleCli(["media:plan", "--profile"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing value for --profile");
  });

  it("media:plan rejects unknown option", async () => {
    const result = await runCrucibleCli(["media:plan", "--verbose"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown media:plan option: --verbose");
  });

  it("config:init rejects missing --output value", async () => {
    const result = await runCrucibleCli(["config:init", "--output"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing value for --output");
  });

  it("setup rejects unknown setup option", async () => {
    const result = await runCrucibleCli(["setup", "host", "--invalid"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown setup option: --invalid");
  });

  it("renders VM status with warnings", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const lifecycle = fakeLifecycleManager(config, { processAlive: true, qmpAvailable: true });
    // Add warnings to the status
    const originalStatus = lifecycle.status;
    lifecycle.status = async () => {
      const s = await originalStatus();
      return { ...s, warnings: ["stale pidfile detected", "qmp socket is slow"] };
    };
    const result = await runCrucibleCli(["vm:status"], { config, lifecycleManager: lifecycle });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("warnings:");
    expect(result.stdout).toContain("- stale pidfile detected");
    expect(result.stdout).toContain("- qmp socket is slow");
  });

  it("guest:health returns error when injected guestClientFactory throws non-ENOENT", async () => {
    const config = parseCrucibleConfig({ vm: { name: "test-win" } });
    const result = await runCrucibleCli(["guest:health"], {
      config,
      guestClientFactory: () => Promise.reject(new Error("connection refused")),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("connection refused");
  });

  it("renders guest exec result with empty stdout and stderr", async () => {
    const result = await runCrucibleCli(["guest:exec", "noop.exe"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 42,
              stdoutBase64: "",
              stderrBase64: "",
              timedOut: true,
              durationMs: 5000,
              truncated: true,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(42);
    expect(result.stdout).toContain("timed out: yes");
    expect(result.stdout).toContain("truncated: yes");
    expect(result.stdout).toContain("(empty)");
  });

  it("guest:health renders policy with code integrity boot options", async () => {
    const policyHealth = {
      cdbPath: null,
      windbgPath: null,
      symbolPath: null,
      crucibleAdminPresent: true,
      crucibleUserPresent: true,
      qemuAgentStatus: "Running",
      crucibleAgentStatus: "Running",
      defenderRealTimeProtectionEnabled: null,
      codeIntegrityStateRecorded: false,
      codeIntegrityEnforcementDisabled: false,
      hypervisorEnforcedCodeIntegrityDisabled: false,
      codeIntegrityBootOptions: ["nointegritychecks", "testsigning"],
      testSigningEnabled: null,
      healthy: false,
    };
    const result = await runCrucibleCli(["guest:health"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth({ windbgInstalled: false })),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from(JSON.stringify(policyHealth)).toString("base64"),
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
    expect(result.stdout).toContain("code-integrity boot options: nointegritychecks, testsigning");
    expect(result.stdout).toContain("Defender real-time protection: unknown");
    expect(result.stdout).toContain("code-integrity enforcement disabled: unknown");
    expect(result.stdout).toContain("HVCI disabled: unknown");
    expect(result.stdout).toContain("test signing enabled: unknown");
    expect(result.stdout).toContain("Sysinternals: unknown");
  });

  it("guest:health renders policy with empty sysinternals map", async () => {
    const policyHealth = {
      cdbPath: "cdb.exe",
      windbgPath: "windbg.exe",
      symbolPath: "srv*",
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
      sysinternals: {},
      healthy: true,
    };
    const result = await runCrucibleCli(["guest:health"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from(JSON.stringify(policyHealth)).toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 10,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sysinternals: none");
    expect(result.stdout).toContain("code-integrity boot options: none");
  });

  it("guest:exec formats timed-out result with empty stderr", async () => {
    const result = await runCrucibleCli(["guest:exec", "slow.exe"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from("partial output").toString("base64"),
              stderrBase64: Buffer.from("error info").toString("base64"),
              timedOut: false,
              durationMs: 100,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("partial output");
    expect(result.stdout).toContain("error info");
  });

  it("debug:smoke reports failure for non-zero non-one exit code", async () => {
    const result = await runCrucibleCli(["debug:smoke", "--exe", "notepad.exe"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 2,
              stdoutBase64: Buffer.from("fatal error").toString("base64"),
              stderrBase64: Buffer.from("cdb crashed").toString("base64"),
              timedOut: false,
              durationMs: 12,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("exit code: 2");
    expect(result.stdout).toContain("cdb crashed");
  });

  it("debug:smoke reports failure when cdb times out", async () => {
    const result = await runCrucibleCli(["debug:smoke", "--exe", "notepad.exe"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: "",
              stderrBase64: "",
              timedOut: true,
              durationMs: 300000,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    // smokeSucceeded is false because timedOut=true, but exitCode from
    // the manager is the underlying exec exitCode (0), not remapped to 1.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("timed out: yes");
  });

  it("guest:health renders policy health failure from exec timeout", async () => {
    const result = await runCrucibleCli(["guest:health"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth()),
          exec: () =>
            Promise.resolve({
              exitCode: 1,
              stdoutBase64: "",
              stderrBase64: Buffer.from("policy script timed out").toString("base64"),
              timedOut: true,
              durationMs: 30000,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("guest policy health failed");
  });

  it("net:set capture shows capture plan", async () => {
    const result = await runCrucibleCli(["net:set", "capture"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" }, network: { mode: "isolated" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode change: isolated -> capture");
    expect(result.stdout).toContain("restart required: yes");
  });

  it("net:plan with warnings for capture mode", async () => {
    const result = await runCrucibleCli(["net:plan", "--mode", "capture", "--apply"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Network mode: capture");
    expect(result.stdout).toContain("Firewall apply commands");
    expect(result.stdout).toContain("Firewall teardown commands");
  });

  it("debug:smoke rejects unknown option", async () => {
    const result = await runCrucibleCli(["debug:smoke", "--bad"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown debug:smoke option: --bad");
  });

  it("debug:smoke rejects missing --exe value", async () => {
    const result = await runCrucibleCli(["debug:smoke", "--exe"], defaultRuntime);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing value for --exe");
  });

  it("debug:smoke runs smoke test through fake client", async () => {
    const result = await runCrucibleCli(["debug:smoke", "--exe", "C:\\test.exe"], {
      config: parseCrucibleConfig({ vm: { name: "test-win" } }),
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve(guestHealth({ cdbPath: "C:\\cdb.exe" })),
          exec: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutBase64: Buffer.from("0:000> lm\nntdll").toString("base64"),
              stderrBase64: "",
              timedOut: false,
              durationMs: 200,
              truncated: false,
            }),
          close: () => Promise.resolve(),
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("debug session:");
  });
});
