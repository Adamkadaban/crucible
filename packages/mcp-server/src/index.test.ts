import { Buffer } from "node:buffer";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { CrucibleError, parseCrucibleConfig, type GuestAgentClient } from "@crucible/core";

import {
  BOOTSTRAP_TOOLS,
  cacheGuestClientFactory,
  createCrucibleMcpServer,
  getMcpServerBanner,
  registerCrucibleTools,
} from "./index.js";

type ToolCallText = { content: ReadonlyArray<{ type: string; text: string }> };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function parseFirstTextPayload<T>(result: ToolCallText): T {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("missing text content");
  return JSON.parse(text) as T;
}

async function harness(options: Parameters<typeof createCrucibleMcpServer>[0]): Promise<Client> {
  const server = createCrucibleMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "crucible-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("crucible MCP tools", () => {
  it("publishes the bootstrap surface", () => {
    expect(getMcpServerBanner()).toMatch(/^crucible MCP server /);
    expect(BOOTSTRAP_TOOLS.map((tool) => tool.name)).toEqual([
      "host_check",
      "vm_status",
      "vm_start",
      "vm_stop",
      "vm_screenshot",
      "vm_display_info",
      "vm_mouse_move",
      "vm_mouse_click",
      "vm_mouse_double_click",
      "vm_mouse_drag",
      "vm_key_press",
      "vm_type_text",
      "network_status",
      "network_set_mode",
      "network_active_status",
      "network_pcap_info",
      "tshark_summary",
      "snapshot_list",
      "snapshot_restore",
      "guest_health",
      "guest_exec",
      "guest_exec_admin",
      "guest_upload_file",
      "guest_read_file",
      "guest_download_file",
      "debug_open",
      "debug_command",
      "debug_dump",
      "debug_run_script",
      "dump_process",
      "process_monitor_start",
      "process_monitor_stop",
      "process_monitor_status",
      "memory_scan",
      "memory_dump_region",
      "debug_close",
    ]);
  });

  it("reports host-prerequisite failures via the structured envelope", async () => {
    const client = await harness({
      hostCheck: () =>
        Promise.resolve({
          healthy: false,
          missing: ["bin:qemu-system-x86_64"],
          notes: "missing prerequisites",
          platform: "linux",
          arch: "x64",
        }),
    });
    const result = (await client.callTool({ name: "host_check", arguments: {} })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error?: { kind: string };
      result?: { missing: string[] };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error?.kind).toBe("host-prerequisite");
    expect(payload.result?.missing).toEqual(["bin:qemu-system-x86_64"]);
  });

  it("marks the host as healthy when the probe succeeds", async () => {
    const client = await harness({
      hostCheck: () =>
        Promise.resolve({
          healthy: true,
          missing: [] as readonly string[],
          notes: "ok",
          platform: "linux",
          arch: "x64",
        }),
    });
    const result = (await client.callTool({ name: "host_check", arguments: {} })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
  });

  it("returns vm-offline when no VM adapter is wired", async () => {
    const client = await harness({});
    const result = (await client.callTool({ name: "vm_status", arguments: {} })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("vm-offline");
  });

  it("exercises every vm + snapshot tool through injected adapters", async () => {
    const fakeVm = {
      status: () => Promise.resolve({ state: "stopped" }),
      start: () => Promise.resolve({ state: "running", pid: 1234 }),
      stop: () => Promise.resolve({ state: "stopped" }),
    };
    const fakeSnapshots = {
      list: () =>
        Promise.resolve([
          { name: "clean-base", path: "snapshots/clean-base.qcow2", createdAt: "2026-01-01" },
        ] as const),
      restore: (name: string) =>
        Promise.resolve({ name, path: `snapshots/${name}.qcow2`, createdAt: "2026-01-01" }),
    };
    const client = await harness({
      vmAdapter: fakeVm,
      snapshotAdapter: fakeSnapshots,
    });
    for (const name of ["vm_status", "vm_start", "vm_stop"] as const) {
      const result = (await client.callTool({ name, arguments: {} })) as ToolCallText;
      const payload = parseFirstTextPayload<{ ok: boolean; result: { state: string } }>(result);
      expect(payload.ok).toBe(true);
      expect(payload.result.state).toMatch(/^(running|stopped)$/);
    }
    const listResult = (await client.callTool({
      name: "snapshot_list",
      arguments: {},
    })) as ToolCallText;
    expect(
      parseFirstTextPayload<{ ok: boolean; result: Array<{ name: string }> }>(listResult).result[0]
        ?.name,
    ).toBe("clean-base");
    const restoreResult = (await client.callTool({
      name: "snapshot_restore",
      arguments: { snapshotName: "clean-base" },
    })) as ToolCallText;
    expect(
      parseFirstTextPayload<{ ok: boolean; result: { name: string } }>(restoreResult).result.name,
    ).toBe("clean-base");
  });

  it("reports missing snapshot adapter and snapshot restore failures", async () => {
    const missing = await harness({});
    const missingList = (await missing.callTool({
      name: "snapshot_list",
      arguments: {},
    })) as ToolCallText;
    const missingRestore = (await missing.callTool({
      name: "snapshot_restore",
      arguments: { snapshotName: "clean-base" },
    })) as ToolCallText;
    const failing = await harness({
      snapshotAdapter: {
        list: () => Promise.reject(new Error("list failed")),
        restore: () => Promise.reject(new Error("restore failed")),
      },
    });
    const failedList = (await failing.callTool({
      name: "snapshot_list",
      arguments: {},
    })) as ToolCallText;
    const failedRestore = (await failing.callTool({
      name: "snapshot_restore",
      arguments: { snapshotName: "clean-base" },
    })) as ToolCallText;

    expect(
      parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(missingList).error.kind,
    ).toBe("vm-offline");
    expect(
      parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(missingRestore).error.kind,
    ).toBe("vm-offline");
    expect(
      parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(failedList).error.message,
    ).toContain("list failed");
    expect(
      parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(failedRestore).error
        .message,
    ).toContain("restore failed");
  });

  it("reports active network status errors and missing pcap validation", async () => {
    const root = await createTempDir("crucible-mcp-state-");
    const client = await harness({
      config: parseCrucibleConfig({
        artifacts: { directory: root },
        vm: { name: "missing-state" },
      }),
    });
    const active = (await client.callTool({
      name: "network_active_status",
      arguments: {},
    })) as ToolCallText;
    const summary = (await client.callTool({
      name: "tshark_summary",
      arguments: {},
    })) as ToolCallText;

    expect(parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(active).error.kind).toBe(
      "validation",
    );
    expect(
      parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(summary).error.kind,
    ).toBe("validation");
  });

  it("reports network status and mode-change restart requirements", async () => {
    const client = await harness({
      config: parseCrucibleConfig({
        vm: { name: "custom-vm" },
        network: { mode: "isolated", controlPort: 9443 },
      }),
    });
    const statusResult = (await client.callTool({
      name: "network_status",
      arguments: {},
    })) as ToolCallText;
    const status = parseFirstTextPayload<{
      ok: boolean;
      result: { configuredMode: string; guestEgress: string };
    }>(statusResult);
    expect(status.ok).toBe(true);
    expect(status.result).toMatchObject({
      configuredMode: "isolated",
      guestEgress: "denied",
      controlPort: 9443,
    });

    const setResult = (await client.callTool({
      name: "network_set_mode",
      arguments: { mode: "nat" },
    })) as ToolCallText;
    const change = parseFirstTextPayload<{
      ok: boolean;
      result: { requestedMode: string; restartRequired: boolean };
    }>(setResult);
    expect(change.result).toMatchObject({ requestedMode: "nat", restartRequired: true });
  });

  it("reports pcap and TLS key log info when capture paths are configured", async () => {
    const pcapPath = `artifacts/downloads/mcp-pcap-${Date.now()}.pcap`;
    const tlsKeyLogPath = `artifacts/downloads/mcp-pcap-${Date.now()}.sslkeylog`;
    await mkdir(path.dirname(pcapPath), { recursive: true });
    await writeFile(pcapPath, Buffer.from("pcap"));
    await writeFile(tlsKeyLogPath, "CLIENT_RANDOM secret\n");
    const client = await harness({
      config: parseCrucibleConfig({
        vm: { name: "capture-vm" },
        network: { mode: "capture", pcapPath, tlsKeyLogPath },
      }),
    });

    const result = (await client.callTool({
      name: "network_pcap_info",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: {
        pcapPath?: string;
        exists: boolean;
        sizeBytes?: number;
        tlsKeyLogPath?: string;
        tlsKeyLogExists?: boolean;
      };
    }>(result);

    expect(payload.result).toMatchObject({
      pcapPath,
      exists: true,
      sizeBytes: 4,
      tlsKeyLogPath,
      tlsKeyLogExists: true,
    });
    await rm(pcapPath, { force: true });
    await rm(tlsKeyLogPath, { force: true });
  });

  it("reports missing tshark as a structured error", async () => {
    const pcapPath = `artifacts/downloads/mcp-tshark-${Date.now()}.pcap`;
    await mkdir(path.dirname(pcapPath), { recursive: true });
    await writeFile(pcapPath, Buffer.from("pcap"));
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    const client = await harness({});
    try {
      const result = (await client.callTool({
        name: "tshark_summary",
        arguments: { pcapPath },
      })) as ToolCallText;
      const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);

      expect(payload.ok).toBe(false);
      expect(payload.error.message).toMatch(/not installed|not on PATH/i);
    } finally {
      process.env.PATH = originalPath;
      await rm(pcapPath, { force: true });
    }
  });

  it("passes TLS key log files to tshark summaries", async () => {
    const root = await createTempDir("crucible-tshark-");
    const pcapPath = path.join(root, "capture.pcap");
    const tlsKeyLogPath = path.join(root, "capture.sslkeylog");
    const binDir = path.join(root, "bin");
    const argsPath = path.join(root, "tshark-args.txt");
    const fakeTshark = path.join(binDir, "tshark");
    await mkdir(binDir, { recursive: true });
    await writeFile(pcapPath, Buffer.from("pcap"));
    await writeFile(tlsKeyLogPath, "CLIENT_RANDOM secret\n");
    await writeFile(
      fakeTshark,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argsPath)}\n`,
      "utf8",
    );
    await chmod(fakeTshark, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    const client = await harness({});

    try {
      const result = (await client.callTool({
        name: "tshark_summary",
        arguments: { pcapPath, tlsKeyLogPath },
      })) as ToolCallText;
      const payload = parseFirstTextPayload<{
        ok: boolean;
        result: { tlsKeyLogPath?: string; tlsKeyLogExists?: boolean };
      }>(result);
      const argsLog = await readFile(argsPath, "utf8");

      expect(payload.ok).toBe(true);
      expect(payload.result).toMatchObject({ tlsKeyLogPath, tlsKeyLogExists: true });
      expect(argsLog).toContain(`tls.keylog_file:${tlsKeyLogPath}`);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns guest-failed when the guest client is missing", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "guest_health",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { kind: string; message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("guest-failed");
    expect(payload.error.message).toMatch(/guest client is not configured/);
  });

  it("round-trips guest_exec and guest_exec_admin through a cached guest client", async () => {
    const execRequests: Array<{
      executable: string;
      as?: string;
      environment?: Record<string, string>;
    }> = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { executable: string; arguments?: string[]; as?: string }) => {
        execRequests.push(req);
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(`ran ${req.executable}`).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    let factoryCalls = 0;
    const factory = cacheGuestClientFactory(() => {
      factoryCalls += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Promise.resolve(fakeClient as any);
    });
    const client = await harness({ guestClientFactory: factory });
    for (let i = 0; i < 3; i += 1) {
      await client.callTool({
        name: "guest_exec",
        arguments:
          i === 0
            ? { executable: "whoami.exe", sslKeyLogFile: "C:\\stage\\tls.keys" }
            : { executable: "whoami.exe" },
      });
    }
    await client.callTool({
      name: "guest_exec_admin",
      arguments: { executable: "whoami.exe" },
    });
    expect(factoryCalls).toBe(1);
    expect(execRequests.map((req) => req.as)).toEqual(["service", "service", "service", "admin"]);
    expect(execRequests[0]?.environment).toMatchObject({ SSLKEYLOGFILE: "C:\\stage\\tls.keys" });
  });

  it("runs persistent debugger commands through the installed CDB path", async () => {
    const opens: Array<{ executable: string; arguments?: readonly string[] }> = [];
    const commands: Array<{ id: string; input: string; waitMs?: number }> = [];
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugOpen: (req: { executable: string; arguments?: readonly string[] }) => {
        opens.push(req);
        return Promise.resolve({
          id: "guest-dbg-1",
          pid: 4321,
          logPath: "C:\\ProgramData\\Crucible\\Exec\\guest-dbg-1.log",
          startedAt: "2026-01-01T00:00:00Z",
        });
      },
      debugCommand: (id: string, input: string, waitMs?: number) => {
        commands.push({ id, input, waitMs });
        return Promise.resolve({
          id,
          outputBase64: Buffer.from("0:000>").toString("base64"),
          truncated: false,
          logPath: "C:\\ProgramData\\Crucible\\Exec\\guest-dbg-1.log",
          exited: false,
        });
      },
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const open = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "attach", pid: 1234 },
    })) as ToolCallText;
    const openPayload = parseFirstTextPayload<{ ok: boolean; result: { id: string } }>(open);
    const sessionId = openPayload.result.id;

    await client.callTool({
      name: "debug_command",
      arguments: { sessionId, commands: ["lm"], waitMs: 25 },
    });

    expect(opens[0]?.executable).toBe(
      "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
    );
    expect(opens[0]?.arguments).toEqual(["-p", "1234"]);
    expect(commands[0]).toEqual({ id: "guest-dbg-1", input: "lm", waitMs: 25 });
  });

  it("routes x86 debugger sessions through x86 CDB", async () => {
    const opens: Array<{ executable: string; arguments?: readonly string[] }> = [];
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugOpen: (req: { executable: string; arguments?: readonly string[] }) => {
        opens.push(req);
        return Promise.resolve({
          id: "guest-dbg-2",
          pid: 4321,
          logPath: "C:\\ProgramData\\Crucible\\Exec\\guest-dbg-2.log",
          startedAt: "2026-01-01T00:00:00Z",
        });
      },
      debugCommand: (id: string) =>
        Promise.resolve({
          id,
          outputBase64: "",
          truncated: false,
          logPath: "C:\\ProgramData\\Crucible\\Exec\\guest-dbg-2.log",
          exited: false,
        }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const open = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "attach", pid: 1234, arch: "x86" },
    })) as ToolCallText;
    const sessionId = parseFirstTextPayload<{ ok: boolean; result: { id: string } }>(open).result
      .id;

    await client.callTool({
      name: "debug_command",
      arguments: { sessionId, commands: ["lm"] },
    });

    expect(opens[0]?.executable).toBe(
      "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x86\\cdb.exe",
    );
  });

  it("runs a debugger script in a temporary persistent session", async () => {
    const opens: Array<{ executable: string; arguments?: readonly string[]; logPath?: string }> =
      [];
    const commands: Array<{ id: string; input: string; waitMs?: number }> = [];
    const closes: string[] = [];
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugOpen: (req: { executable: string; arguments?: readonly string[]; logPath?: string }) => {
        opens.push(req);
        return Promise.resolve({
          id: "guest-dbg-script",
          pid: 4321,
          logPath: req.logPath ?? "C:\\ProgramData\\Crucible\\Exec\\guest-dbg-script.log",
          startedAt: "2026-01-01T00:00:00Z",
        });
      },
      debugCommand: (id: string, input: string, waitMs?: number) => {
        commands.push({ id, input, waitMs });
        return Promise.resolve({
          id,
          outputBase64: Buffer.from("script-output").toString("base64"),
          truncated: false,
          logPath: "C:\\logs\\run.log",
          exited: false,
        });
      },
      debugClose: (id: string) => {
        closes.push(id);
        return Promise.resolve({ id, closed: true });
      },
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const result = (await client.callTool({
      name: "debug_run_script",
      arguments: {
        target: { mode: "attach", pid: 1234, debuggerArch: "auto", initialCommands: ["sxd wob"] },
        script: "lm\nr",
        timeoutMs: 5_000,
        logPath: "C:\\logs\\run.log",
      },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { stdoutBase64: string; logPath: string };
    }>(result);

    expect(payload.ok).toBe(true);
    expect(opens[0]).toMatchObject({ arguments: ["-p", "1234"], logPath: "C:\\logs\\run.log" });
    expect(commands).toEqual([
      { id: "guest-dbg-script", input: "sxd wob", waitMs: 1_000 },
      { id: "guest-dbg-script", input: "lm\nr", waitMs: 5_000 },
    ]);
    expect(Buffer.from(payload.result.stdoutBase64, "base64").toString()).toBe("script-output");
    expect(closes).toEqual(["guest-dbg-script"]);
  });

  it("runs dump_process through ProcDump as admin", async () => {
    const execRequests: Array<{ executable: string; arguments?: readonly string[]; as?: string }> =
      [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { executable: string; arguments?: readonly string[]; as?: string }) => {
        execRequests.push(req);
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(
            JSON.stringify({
              pid: 1234,
              outputGuestPath: "C:\\Dumps\\p.dmp",
              full: true,
              sizeBytes: 42,
              sha256: "deadbeef",
              tool: "procdump64.exe",
            }),
          ).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const result = (await client.callTool({
      name: "dump_process",
      arguments: { pid: 1234, outputGuestPath: "C:\\Dumps\\p.dmp", full: true },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { outputGuestPath: string; sizeBytes: number };
    }>(result);

    expect(payload.ok).toBe(true);
    expect(payload.result).toMatchObject({ outputGuestPath: "C:\\Dumps\\p.dmp", sizeBytes: 42 });
    expect(execRequests[0]?.as).toBe("admin");
    expect(execRequests[0]?.arguments?.join(" ")).toContain("procdump64.exe");
    expect(execRequests[0]?.arguments?.join(" ")).toContain("RedirectStandardOutput");
    expect(execRequests[0]?.arguments?.join(" ")).toContain("'-ma'");
  });

  it("requests a mini dump when dump_process full is false", async () => {
    const execRequests: Array<{ arguments?: readonly string[] }> = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { arguments?: readonly string[] }) => {
        execRequests.push(req);
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(
            JSON.stringify({
              pid: 1234,
              outputGuestPath: "C:\\Dumps\\p.dmp",
              full: false,
              sizeBytes: 42,
              sha256: "deadbeef",
              tool: "procdump64.exe",
            }),
          ).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    await client.callTool({
      name: "dump_process",
      arguments: { pid: 1234, outputGuestPath: "C:\\Dumps\\p.dmp", full: false },
    });

    expect(execRequests[0]?.arguments?.join(" ")).toContain("'-mm'");
  });

  it("supports comsvcs dump method and suspend option", async () => {
    const execRequests: Array<{ arguments?: readonly string[] }> = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { arguments?: readonly string[] }) => {
        execRequests.push(req);
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(
            JSON.stringify({
              pid: 1234,
              outputGuestPath: "C:\\Dumps\\p.dmp",
              method: "comsvcs",
              sizeBytes: 42,
              sha256: "deadbeef",
              tool: "comsvcs.dll",
              suspended: true,
            }),
          ).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    await client.callTool({
      name: "dump_process",
      arguments: {
        pid: 1234,
        outputGuestPath: "C:\\Dumps\\p.dmp",
        method: "comsvcs",
        suspend: true,
      },
    });

    const command = execRequests[0]?.arguments?.join(" ") ?? "";
    expect(command).toContain("comsvcs.dll");
    expect(command).toContain("Suspend-Process");
  });

  it("starts and stops a ProcMon-backed process monitor", async () => {
    const execRequests: Array<{ arguments?: readonly string[] }> = [];
    let call = 0;
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { arguments?: readonly string[] }) => {
        execRequests.push(req);
        call += 1;
        const payload =
          call === 1
            ? { monitorId: "mon-test", outputGuestPath: "C:\\mon.pml", tool: "Procmon64.exe" }
            : {
                monitorId: "mon-test",
                events: 2,
                outputGuestPath: "C:\\mon.pml",
                csvGuestPath: "C:\\mon.csv",
                summary: { processCreates: 1, fileWrites: 1, registrySets: 0, networkConnects: 0 },
              };
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const start = (await client.callTool({
      name: "process_monitor_start",
      arguments: { targetPid: 1234 },
    })) as ToolCallText;
    const startPayload = parseFirstTextPayload<{ ok: boolean; result: { monitorId: string } }>(
      start,
    );
    const stop = (await client.callTool({
      name: "process_monitor_stop",
      arguments: { monitorId: startPayload.result.monitorId },
    })) as ToolCallText;
    const stopPayload = parseFirstTextPayload<{
      ok: boolean;
      result: { summary: { processCreates: number } };
    }>(stop);

    expect(startPayload.result.monitorId).toBe("mon-test");
    expect(stopPayload.result.summary.processCreates).toBe(1);
    expect(execRequests[0]?.arguments?.join(" ")).toContain("Procmon64.exe");
    expect(execRequests[0]?.arguments?.join(" ")).toContain("already running");
    expect(execRequests[1]?.arguments?.join(" ")).toContain("/Terminate");
    expect(execRequests[1]?.arguments?.join(" ")).toContain("^WriteFile$");
  });

  it("reports ProcMon stop empty stdout with stderr context", async () => {
    let call = 0;
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () => {
        call += 1;
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64:
            call === 1
              ? Buffer.from(
                  JSON.stringify({ monitorId: "mon-test", outputGuestPath: "C:\\mon.pml" }),
                ).toString("base64")
              : "",
          stderrBase64: call === 2 ? Buffer.from("conversion failed").toString("base64") : "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    await client.callTool({ name: "process_monitor_start", arguments: {} });
    const stop = (await client.callTool({
      name: "process_monitor_stop",
      arguments: { monitorId: "mon-test" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(stop);

    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("conversion failed");
  });

  it("runs memory scan and region dump scripts as admin", async () => {
    const execRequests: Array<{ arguments?: readonly string[]; as?: string }> = [];
    let call = 0;
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { arguments?: readonly string[]; as?: string }) => {
        execRequests.push(req);
        call += 1;
        const payload =
          call === 1
            ? { pid: 1234, matches: [{ pattern: "MZ", address: "0x1000" }] }
            : { outputGuestPath: "C:\\region.bin", sizeBytes: 16, sha256: "deadbeef" };
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const scan = (await client.callTool({
      name: "memory_scan",
      arguments: { pid: 1234, patterns: ["4d5a", "QuantumMind"], regions: "private" },
    })) as ToolCallText;
    const dump = (await client.callTool({
      name: "memory_dump_region",
      arguments: { pid: 1234, baseAddress: "0x1000", size: 16, outputGuestPath: "C:\\region.bin" },
    })) as ToolCallText;
    const scanPayload = parseFirstTextPayload<{ ok: boolean; result: { matches: unknown[] } }>(
      scan,
    );
    const dumpPayload = parseFirstTextPayload<{ ok: boolean; result: { sizeBytes: number } }>(dump);

    expect(scanPayload.result.matches).toHaveLength(1);
    expect(dumpPayload.result.sizeBytes).toBe(16);
    expect(execRequests.map((req) => req.as)).toEqual(["admin", "admin"]);
    expect(execRequests[0]?.arguments?.join(" ")).toContain("CrucibleMemory");
  });

  it("reports memory helper empty stdout with stderr context", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          stdoutBase64: "",
          stderrBase64: Buffer.from("helper wrote no output").toString("base64"),
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const scan = (await client.callTool({
      name: "memory_scan",
      arguments: { pid: 1234, patterns: ["4d5a"] },
    })) as ToolCallText;
    const dump = (await client.callTool({
      name: "memory_dump_region",
      arguments: { pid: 1234, baseAddress: "0x1000", size: 16, outputGuestPath: "C:\\region.bin" },
    })) as ToolCallText;
    const scanPayload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(scan);
    const dumpPayload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(dump);

    expect(scanPayload.ok).toBe(false);
    expect(scanPayload.error.message).toContain("helper wrote no output");
    expect(dumpPayload.ok).toBe(false);
    expect(dumpPayload.error.message).toContain("helper wrote no output");
  });

  it("returns isError when guest_exec input fails Zod validation", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "guest_exec",
      arguments: { arguments: ["whoami"] },
    })) as ToolCallText & { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("uploads an existing host file through guest_upload_file", async () => {
    const dir = await createTempDir("crucible-mcp-upload-");
    const hostPath = path.join(dir, "sample.bin");
    await writeFile(hostPath, Buffer.from("sample"));
    const uploads: Array<{ hostPath: string; guestPath: string }> = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: (uploadedHostPath: string, guestPath: string) => {
        uploads.push({ hostPath: uploadedHostPath, guestPath });
        return Promise.resolve({
          path: guestPath,
          sizeBytes: 6,
          sha256: "deadbeef",
        });
      },
      downloadFile: () => Promise.resolve({ path: "guest", sizeBytes: 0, sha256: "deadbeef" }),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const result = (await client.callTool({
      name: "guest_upload_file",
      arguments: { hostPath, guestPath: "samples/sample.bin" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: { sizeBytes: number } }>(result);

    expect(payload.ok).toBe(true);
    expect(payload.result.sizeBytes).toBe(6);
    expect(uploads[0]).toEqual({ hostPath, guestPath: "samples/sample.bin" });
  });

  it("rejects relative host paths in guest_upload_file", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "guest_upload_file",
      arguments: { hostPath: "samples/payload.exe", guestPath: "payload.exe" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { kind: string; message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatchObject({
      kind: "validation",
      message: "hostPath must be absolute",
    });
  });

  it("reads small ASCII guest files inline", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () => Promise.reject(new Error("unused")),
      inspect: () =>
        Promise.resolve({
          path: "logs/out.txt",
          sizeBytes: "hello\ncrucible\n".length,
          headerHex: Buffer.from("hello\ncrucible\n", "ascii").toString("hex"),
          headerAscii: "hello.crucible.",
        }),
      download: () => Promise.resolve(Buffer.from("hello\ncrucible\n", "ascii")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const result = (await client.callTool({
      name: "guest_read_file",
      arguments: { sourcePath: "logs/out.txt" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { inline: boolean; encoding?: string; contents?: string };
    }>(result);

    expect(payload.ok).toBe(true);
    expect(payload.result).toMatchObject({
      inline: true,
      encoding: "ascii",
      contents: "hello\ncrucible\n",
    });
  });

  it("reports header metadata for binary guest files", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () => Promise.reject(new Error("unused")),
      inspect: () =>
        Promise.resolve({
          path: "samples/payload.exe",
          sizeBytes: 5,
          headerHex: "4d5a0090ff",
          headerAscii: "MZ...",
        }),
      download: () => Promise.resolve(Buffer.from([0x4d, 0x5a, 0x00, 0x90, 0xff])),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const result = (await client.callTool({
      name: "guest_read_file",
      arguments: { sourcePath: "samples/payload.exe" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { inline: boolean; reason: string; headerHex: string; headerAscii: string };
    }>(result);

    expect(payload.result).toMatchObject({
      inline: false,
      reason: "non-ascii",
      headerHex: "4d5a0090ff",
      headerAscii: "MZ...",
    });
  });

  it("downloads a guest file to a new host path through guest_download_file", async () => {
    const hostPath = `artifacts/downloads/mcp-test-${Date.now()}.bin`;
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () => Promise.reject(new Error("unused")),
      downloadFile: async (guestPath: string, outputHostPath: string) => {
        await writeFile(outputHostPath, `downloaded:${guestPath}`);
        return { path: guestPath, sizeBytes: `downloaded:${guestPath}`.length, sha256: "deadbeef" };
      },
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const result = (await client.callTool({
      name: "guest_download_file",
      arguments: { guestPath: "artifacts/out.bin", hostPath },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { sizeBytes: number; hostPath: string };
    }>(result);

    expect(payload.ok).toBe(true);
    expect(payload.result).toMatchObject({
      hostPath,
      sizeBytes: "downloaded:artifacts/out.bin".length,
    });
    await expect(readFile(hostPath, "utf8")).resolves.toBe("downloaded:artifacts/out.bin");
    await rm(hostPath, { force: true });
  });

  it("createCrucibleMcpServer rejects duplicate tool registration", () => {
    const server = createCrucibleMcpServer({});
    expect(() => registerCrucibleTools({ server })).toThrow(/already registered/i);
  });

  it("exercises debug_open / debug_command / debug_dump / debug_close via injected manager", async () => {
    const { DebuggerSessionManager } = await import("@crucible/core");
    const calls: Array<readonly string[]> = [];
    const manager = new DebuggerSessionManager({
      run: (args) => {
        calls.push(args);
        return Promise.resolve({
          stdoutBase64: Buffer.from("0:000>").toString("base64"),
          stderrBase64: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
          durationMs: 7,
        });
      },
      idFactory: () => "dbg-abc",
    });
    const client = await harness({ debuggerManager: manager });

    const openResult = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "attach", pid: 1234 },
    })) as ToolCallText;
    const openPayload = parseFirstTextPayload<{ ok: boolean; result: { id: string } }>(openResult);
    expect(openPayload.ok).toBe(true);
    expect(openPayload.result.id).toBe("dbg-abc");

    const commandResult = (await client.callTool({
      name: "debug_command",
      arguments: { sessionId: "dbg-abc", commands: ["!analyze -v"] },
    })) as ToolCallText;
    expect(
      parseFirstTextPayload<{ ok: boolean; result: { command: string } }>(commandResult).result
        .command,
    ).toBe("!analyze -v");
    expect(calls[0]).toEqual(["-c", "!analyze -v; q", "-p", "1234"]);

    const dumpResult = (await client.callTool({
      name: "debug_dump",
      arguments: {
        sessionId: "dbg-abc",
        outputGuestPath: "C:\\ProgramData\\Crucible\\dump.dmp",
      },
    })) as ToolCallText;
    expect(
      parseFirstTextPayload<{ ok: boolean; result: { command: string } }>(dumpResult).result
        .command,
    ).toBe(".dump /ma C:\\ProgramData\\Crucible\\dump.dmp");

    const closeResult = (await client.callTool({
      name: "debug_close",
      arguments: { sessionId: "dbg-abc" },
    })) as ToolCallText;
    const closePayload = parseFirstTextPayload<{
      ok: boolean;
      result: { id: string; closed: boolean };
    }>(closeResult);
    expect(closePayload.result.closed).toBe(true);
  });

  it("reports vm-offline when debugger tools have no manager / guest client", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "attach", pid: 1 },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("vm-offline");
  });

  it("debug_open creates a debugger session through guest_exec", async () => {
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugOpen: () =>
        Promise.resolve({
          id: "sess-42",
          pid: 9999,
          logPath: "C:\\logs\\sess-42.log",
          startedAt: "2026-05-31T00:00:00Z",
        }),
      debugCommand: () =>
        Promise.resolve({
          id: "sess-42",
          outputBase64: "",
          truncated: false,
          logPath: "C:\\logs\\sess-42.log",
          exited: false,
        }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "attach", pid: 1234 },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: { id: string } }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.id).toBe("sess-42");
  });

  it("debug_command sends commands to an existing session", async () => {
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugOpen: () =>
        Promise.resolve({
          id: "sess-cmd",
          pid: 9999,
          logPath: "C:\\logs\\sess-cmd.log",
          startedAt: "2026-05-31T00:00:00Z",
        }),
      debugCommand: (id: string, input: string) =>
        Promise.resolve({
          id,
          outputBase64: Buffer.from(`output for: ${input}`).toString("base64"),
          truncated: false,
          logPath: "C:\\logs\\sess-cmd.log",
          exited: false,
        }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_command",
      arguments: { sessionId: "sess-cmd", commands: ["k", "lm"] },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { command: string; stdoutBase64: string };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.command).toBe("k; lm");
    expect(Buffer.from(payload.result.stdoutBase64, "base64").toString()).toContain("output for:");
  });

  it("debug_close closes a session", async () => {
    const closes: string[] = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      debugClose: (id: string) => {
        closes.push(id);
        return Promise.resolve({ id, closed: true });
      },
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_close",
      arguments: { sessionId: "sess-to-close" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: { id: string; closed: boolean } }>(
      result,
    );
    expect(payload.ok).toBe(true);
    expect(payload.result.closed).toBe(true);
    expect(closes).toEqual(["sess-to-close"]);
  });

  it("debug_open returns error when guest agent fails", async () => {
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Debuggers\\cdb.exe",
        }),
      debugOpen: () => Promise.reject(new Error("guest agent connection refused")),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "attach", pid: 1234 },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("guest agent connection refused");
  });

  it("guest_health reports error when guest client throws", async () => {
    const client = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.reject(new Error("agent unreachable")),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("unused")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_health",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { kind: string; message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("agent unreachable");
  });

  it("guest_exec reports error when guest client exec fails", async () => {
    const client = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve({ status: "ok" }),
          exec: () => Promise.reject(new Error("exec failed")),
          uploadFile: () => Promise.reject(new Error("unused")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_exec",
      arguments: { executable: "whoami.exe" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("exec failed");
  });

  it("guest_exec_admin reports error when guest client exec fails", async () => {
    const client = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve({ status: "ok" }),
          exec: () => Promise.reject(new Error("admin exec failed")),
          uploadFile: () => Promise.reject(new Error("unused")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_exec_admin",
      arguments: { executable: "whoami.exe" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("admin exec failed");
  });

  it("guest_upload_file reports error when upload fails", async () => {
    const dir = await createTempDir("crucible-mcp-upload-err-");
    const hostPath = path.join(dir, "sample.bin");
    await writeFile(hostPath, "data");
    const client = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve({ status: "ok" }),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("upload transport error")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_upload_file",
      arguments: { hostPath, guestPath: "C:\\stage\\sample.bin" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("upload transport error");
  });

  it("guest_read_file reports error when inspect fails", async () => {
    const client = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve({ status: "ok" }),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("unused")),
          inspect: () => Promise.reject(new Error("file not found")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_read_file",
      arguments: { sourcePath: "missing.txt" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("file not found");
  });

  it("guest_download_file reports error when download fails", async () => {
    const hostPath = `artifacts/downloads/mcp-dl-err-${Date.now()}.bin`;
    const client = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.resolve({ status: "ok" }),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("unused")),
          downloadFile: () => Promise.reject(new Error("download failed")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_download_file",
      arguments: { guestPath: "C:\\data.bin", hostPath },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("download failed");
    await rm(hostPath, { force: true }).catch(() => {});
  });

  it("debug_open validates discriminated union input (missing executable for launch)", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "attach" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { kind: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("validation");
  });

  it("debug_open with initial commands through guest agent", async () => {
    const commands: Array<{ id: string; input: string }> = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok", cdbPath: "C:\\cdb.exe" }),
      debugOpen: () =>
        Promise.resolve({
          id: "sess-init",
          pid: 4321,
          logPath: "C:\\log.txt",
          startedAt: "2026-01-01",
        }),
      debugCommand: (id: string, input: string) => {
        commands.push({ id, input });
        return Promise.resolve({
          id,
          outputBase64: Buffer.from("initial-output").toString("base64"),
          truncated: false,
          logPath: "C:\\log.txt",
          exited: false,
        });
      },
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_open",
      arguments: {
        mode: "launch",
        executable: "C:\\test.exe",
        symbolPath: "srv*C:\\symbols",
        initialCommands: ["sxd av"],
      },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { id: string; stdoutBase64: string; cdbExecutable: string };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.id).toBe("sess-init");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toBe("sxd av");
    expect(Buffer.from(payload.result.stdoutBase64, "base64").toString()).toBe("initial-output");
  });

  it("memory_scan reports non-zero exit code", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 1,
          stdoutBase64: "",
          stderrBase64: Buffer.from("OpenProcess failed").toString("base64"),
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "memory_scan",
      arguments: { pid: 9999, patterns: ["4d5a"] },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("OpenProcess failed");
  });

  it("memory_dump_region reports non-zero exit code", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 1,
          stdoutBase64: "",
          stderrBase64: Buffer.from("ReadProcessMemory failed").toString("base64"),
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "memory_dump_region",
      arguments: { pid: 9999, baseAddress: "0x1000", size: 16, outputGuestPath: "C:\\out.bin" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("ReadProcessMemory failed");
  });

  it("process_monitor_start requires a running VM", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "process_monitor_start",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toMatch(/guest-failed|vm-offline/);
  });

  it("process_monitor_stop requires a valid monitor ID", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 1,
          stdoutBase64: "",
          stderrBase64: Buffer.from("ProcMon backing file not found for monitor bogus-id").toString(
            "base64",
          ),
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "process_monitor_stop",
      arguments: { monitorId: "bogus-id" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("ProcMon backing file not found");
  });

  it("tshark_summary returns error when tshark is not installed", async () => {
    const dir = await createTempDir("crucible-tshark-missing-");
    const pcapPath = path.join(dir, "test.pcap");
    await writeFile(pcapPath, Buffer.from("pcap"));
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    const client = await harness({});
    try {
      const result = (await client.callTool({
        name: "tshark_summary",
        arguments: { pcapPath },
      })) as ToolCallText;
      const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
      expect(payload.ok).toBe(false);
      expect(payload.error.message).toMatch(/not installed|not on PATH/i);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("guest_exec_admin runs with admin privilege", async () => {
    const execRequests: Array<{ executable: string; as?: string }> = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { executable: string; as?: string }) => {
        execRequests.push(req);
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from("admin output").toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_exec_admin",
      arguments: { executable: "net.exe", arguments: ["user"] },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
    expect(execRequests[0]?.as).toBe("admin");
  });

  it("dump_process dispatches to memory helper with admin", async () => {
    const execRequests: Array<{ as?: string }> = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { as?: string }) => {
        execRequests.push(req);
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(
            JSON.stringify({
              pid: 5678,
              outputGuestPath: "C:\\Dumps\\proc.dmp",
              full: true,
              sizeBytes: 100,
              sha256: "abcdef",
              tool: "procdump64.exe",
            }),
          ).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "dump_process",
      arguments: { pid: 5678 },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { pid: number; outputGuestPath: string };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.pid).toBe(5678);
    expect(execRequests[0]?.as).toBe("admin");
  });

  it("vm_start returns error when lifecycle is not available", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "vm_start",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("vm-offline");
  });

  it("vm_stop returns result when VM is already stopped", async () => {
    const fakeVm = {
      status: () => Promise.resolve({ state: "stopped" }),
      start: () => Promise.resolve({ state: "running", pid: 1234 }),
      stop: () => Promise.resolve({ state: "stopped" }),
    };
    const client = await harness({ vmAdapter: fakeVm });
    const result = (await client.callTool({
      name: "vm_stop",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: { state: string } }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.state).toBe("stopped");
  });

  it("vm_screenshot returns error when adapter has no screenshot", async () => {
    const fakeVm = {
      status: () => Promise.resolve({ state: "running" }),
      start: () => Promise.resolve({ state: "running", pid: 1234 }),
      stop: () => Promise.resolve({ state: "stopped" }),
    };
    const client = await harness({ vmAdapter: fakeVm });
    const result = (await client.callTool({
      name: "vm_screenshot",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { kind: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("vm-offline");
  });

  it("vm_screenshot captures screenshot", async () => {
    const fakeVm = {
      status: () => Promise.resolve({ state: "running" }),
      start: () => Promise.resolve({ state: "running", pid: 1234 }),
      stop: () => Promise.resolve({ state: "stopped" }),
      screenshot: (outputPath: string) => Promise.resolve({ path: outputPath, sizeBytes: 1234 }),
    };
    const client = await harness({ vmAdapter: fakeVm });
    const result = (await client.callTool({
      name: "vm_screenshot",
      arguments: { outputPath: "test.ppm" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { path: string; sizeBytes: number };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.path).toBe("test.ppm");
    expect(payload.result.sizeBytes).toBe(1234);
  });

  it("dispatches VM display input tools through the adapter", async () => {
    const calls: string[] = [];
    const fakeVm = {
      status: () => Promise.resolve({ state: "running" }),
      start: () => Promise.resolve({ state: "running", pid: 1234 }),
      stop: () => Promise.resolve({ state: "stopped" }),
      displayInfo: () => Promise.resolve({ available: true, inputAvailable: true, backend: "fake" }),
      mouseMove: (x: number, y: number) => {
        calls.push(`move:${x},${y}`);
        return Promise.resolve({ action: "mouse_move", x, y });
      },
      mouseClick: (input: { x?: number; y?: number; button: "left" | "middle" | "right" }) => {
        calls.push(`click:${input.x ?? "current"},${input.y ?? "current"},${input.button}`);
        return Promise.resolve({ action: "mouse_click", ...input });
      },
      mouseDoubleClick: (input: {
        x?: number;
        y?: number;
        button: "left" | "middle" | "right";
      }) => {
        calls.push(`double:${input.x ?? "current"},${input.y ?? "current"},${input.button}`);
        return Promise.resolve({ action: "mouse_double_click", ...input });
      },
      mouseDrag: (input: {
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
        button: "left" | "middle" | "right";
      }) => {
        calls.push(`drag:${input.fromX},${input.fromY},${input.toX},${input.toY},${input.button}`);
        return Promise.resolve({ action: "mouse_drag", x: input.toX, y: input.toY, button: input.button });
      },
      keyPress: (key: string) => {
        calls.push(`key:${key}`);
        return Promise.resolve({ action: "key_press", key });
      },
      typeText: (text: string, delayMs?: number) => {
        calls.push(`type:${text}:${delayMs ?? "none"}`);
        return Promise.resolve({ action: "type_text", textLength: text.length });
      },
    };
    const client = await harness({ vmAdapter: fakeVm });

    const display = (await client.callTool({ name: "vm_display_info", arguments: {} })) as ToolCallText;
    await client.callTool({ name: "vm_mouse_move", arguments: { x: 10, y: 20 } });
    await client.callTool({ name: "vm_mouse_click", arguments: { x: 30, y: 40 } });
    await client.callTool({ name: "vm_mouse_double_click", arguments: { button: "right" } });
    await client.callTool({
      name: "vm_mouse_drag",
      arguments: { fromX: 1, fromY: 2, toX: 3, toY: 4, button: "middle" },
    });
    await client.callTool({ name: "vm_key_press", arguments: { key: "Ctrl+L" } });
    await client.callTool({ name: "vm_type_text", arguments: { text: "abc", delayMs: 1 } });

    expect(parseFirstTextPayload<{ ok: boolean; result: { backend: string } }>(display).result.backend).toBe(
      "fake",
    );
    expect(calls).toEqual([
      "move:10,20",
      "click:30,40,left",
      "double:current,current,right",
      "drag:1,2,3,4,middle",
      "key:Ctrl+L",
      "type:abc:1",
    ]);
  });

  it("validates paired VM mouse click coordinates", async () => {
    const client = await harness({
      vmAdapter: {
        status: () => Promise.resolve({ state: "running" }),
        start: () => Promise.resolve({ state: "running", pid: 1234 }),
        stop: () => Promise.resolve({ state: "stopped" }),
        mouseClick: () => Promise.resolve({ action: "mouse_click" }),
      },
    });
    const result = (await client.callTool({
      name: "vm_mouse_click",
      arguments: { x: 30 },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { kind: string; message: string } }>(
      result,
    );
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("validation");
    expect(payload.error.message).toContain("x and y");
  });

  it("reports unsupported VM display input tools", async () => {
    const client = await harness({
      vmAdapter: {
        status: () => Promise.resolve({ state: "running" }),
        start: () => Promise.resolve({ state: "running", pid: 1234 }),
        stop: () => Promise.resolve({ state: "stopped" }),
      },
    });
    const result = (await client.callTool({
      name: "vm_key_press",
      arguments: { key: "Ctrl+L" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { kind: string; message: string } }>(
      result,
    );
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("vm-offline");
    expect(payload.error.message).toContain("key input");
  });

  it("debug_open launches a debug session via guest agent", async () => {
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugOpen: () =>
        Promise.resolve({
          id: "sess-1",
          pid: 1234,
          logPath: "C:\\log.txt",
          startedAt: "2026-01-01",
        }),
      debugCommand: () =>
        Promise.resolve({
          id: "sess-1",
          outputBase64: "",
          truncated: false,
          logPath: "C:\\log.txt",
          exited: false,
        }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "launch", executable: "C:\\test.exe" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
  });

  it("debug_command sends commands", async () => {
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugCommand: (_id: string, _input: string) =>
        Promise.resolve({
          id: "sess-1",
          outputBase64: btoa("output"),
          truncated: false,
          logPath: "C:\\log.txt",
          exited: false,
        }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_command",
      arguments: { sessionId: "sess-1", commands: ["k"] },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
  });

  it("debug_close closes session", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      debugClose: (_id: string) => Promise.resolve({ id: "sess-1", closed: true }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_close",
      arguments: { sessionId: "sess-1" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
  });

  it("debug_open returns error when guest is unreachable", async () => {
    const client = await harness({
      guestClientFactory: () => Promise.reject(new Error("connection refused")),
    });
    const result = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "launch", executable: "C:\\test.exe" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(false);
  });

  it("debug_dump captures dump", async () => {
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugCommand: (_id: string, _input: string) =>
        Promise.resolve({
          id: "sess-1",
          outputBase64: Buffer.from("dump ok").toString("base64"),
          truncated: false,
          logPath: "C:\\log.txt",
          exited: false,
        }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_dump",
      arguments: { sessionId: "sess-1", outputGuestPath: "C:\\dump.dmp" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
  });

  it("debug_run_script executes script", async () => {
    const fakeClient = {
      health: () =>
        Promise.resolve({
          status: "ok",
          cdbPath: "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
        }),
      debugOpen: (_req: { executable: string }) =>
        Promise.resolve({
          id: "sess-script",
          pid: 4321,
          logPath: "C:\\log.txt",
          startedAt: "2026-01-01",
        }),
      debugCommand: (_id: string, _input: string) =>
        Promise.resolve({
          id: "sess-script",
          outputBase64: Buffer.from("script output").toString("base64"),
          truncated: false,
          logPath: "C:\\log.txt",
          exited: false,
        }),
      debugClose: (_id: string) => Promise.resolve({ id: "sess-script", closed: true }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_run_script",
      arguments: {
        target: { mode: "attach", pid: 1234 },
        script: "lm",
      },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
  });

  it("vm_status returns status when no VM is running", async () => {
    const fakeVm = {
      status: () => Promise.resolve({ state: "stopped" }),
      start: () => Promise.resolve({ state: "running", pid: 1234 }),
      stop: () => Promise.resolve({ state: "stopped" }),
    };
    const client = await harness({ vmAdapter: fakeVm });
    const result = (await client.callTool({ name: "vm_status", arguments: {} })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: { state: string } }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.state).toBe("stopped");
  });

  it("vm_start returns error when QEMU can't be started", async () => {
    const fakeVm = {
      status: () => Promise.resolve({ state: "stopped" }),
      start: () => Promise.reject(new Error("QEMU binary not found")),
      stop: () => Promise.resolve({ state: "stopped" }),
    };
    const client = await harness({ vmAdapter: fakeVm });
    const result = (await client.callTool({ name: "vm_start", arguments: {} })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("QEMU binary not found");
  });

  it("snapshot_restore restores a named snapshot", async () => {
    const fakeSnapshots = {
      list: () => Promise.resolve([]),
      restore: (name: string) =>
        Promise.resolve({ name, path: `snapshots/${name}.qcow2`, createdAt: "2026-01-01" }),
    };
    const client = await harness({ snapshotAdapter: fakeSnapshots });
    const result = (await client.callTool({
      name: "snapshot_restore",
      arguments: { snapshotName: "analysis-checkpoint" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: { name: string } }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.name).toBe("analysis-checkpoint");
  });

  it("pcap_info returns ok with no pcap when pcap path is not configured", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "network_pcap_info",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { pcapPath?: string; exists: boolean };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.exists).toBe(false);
  });

  it("network_set_mode changes mode to nat", async () => {
    const client = await harness({
      config: parseCrucibleConfig({
        vm: { name: "test-vm" },
        network: { mode: "isolated" },
      }),
    });
    const result = (await client.callTool({
      name: "network_set_mode",
      arguments: { mode: "nat" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { requestedMode: string; restartRequired: boolean };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.requestedMode).toBe("nat");
    expect(payload.result.restartRequired).toBe(true);
  });

  it("network_active_status reads persisted state file", async () => {
    const root = await createTempDir("crucible-mcp-active-");
    const stateDir = path.join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "active-vm.json"),
      JSON.stringify({
        qemu: {
          args: ["user,id=crucible-active-vm-net0,restrict=off,net=192.0.2.0/29,host=192.0.2.1"],
        },
      }),
    );
    const client = await harness({
      config: parseCrucibleConfig({
        artifacts: { directory: root },
        vm: { name: "active-vm" },
        network: { mode: "nat" },
      }),
    });
    const result = (await client.callTool({
      name: "network_active_status",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { configuredMode: string; activeMode: string; matchesConfiguredMode: boolean };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.activeMode).toBe("nat");
    expect(payload.result.matchesConfiguredMode).toBe(true);
  });

  it("network_active_status detects capture mode from tap args", async () => {
    const root = await createTempDir("crucible-mcp-active-tap-");
    const stateDir = path.join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "tap-vm.json"),
      JSON.stringify({
        qemu: {
          args: [
            "tap,id=crucible-tap-vm-net0,ifname=crucible-tap-vm-net0-tap",
            "filter-dump,id=dump0,netdev=crucible-tap-vm-net0,file=/tmp/capture.pcap",
          ],
        },
      }),
    );
    const client = await harness({
      config: parseCrucibleConfig({
        artifacts: { directory: root },
        vm: { name: "tap-vm" },
        network: { mode: "capture" },
      }),
    });
    const result = (await client.callTool({
      name: "network_active_status",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { activeMode: string; activeBackend: string; pcapPath?: string };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.activeMode).toBe("capture");
    expect(payload.result.activeBackend).toBe("tap");
    expect(payload.result.pcapPath).toBe("/tmp/capture.pcap");
  });

  it("host_check handles exception from probe", async () => {
    const client = await harness({
      hostCheck: () => Promise.reject(new Error("probe exploded")),
    });
    const result = (await client.callTool({ name: "host_check", arguments: {} })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { kind: string; message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("host-prerequisite");
    expect(payload.error.message).toContain("probe exploded");
  });

  it("debug_open returns validation error for invalid input", async () => {
    const client = await harness({
      guestClientFactory: () => Promise.reject(new Error("unused")),
    });
    const result = (await client.callTool({
      name: "debug_open",
      arguments: { mode: "launch" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { kind: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("validation");
  });

  it("guest_upload_file rejects non-file host path", async () => {
    const dir = await createTempDir("crucible-mcp-upload-dir-");
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_upload_file",
      arguments: { hostPath: dir, guestPath: "C:\\stage\\dir" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { kind: string; message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe("validation");
    expect(payload.error.message).toContain("not a regular file");
  });

  it("guest_read_file returns too-large metadata for oversized files", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () => Promise.reject(new Error("unused")),
      inspect: () =>
        Promise.resolve({
          path: "big.bin",
          sizeBytes: 100 * 1024, // 100 KiB > 64 KiB limit
          headerHex: "4d5a",
          headerAscii: "MZ",
        }),
      download: () => Promise.resolve(Buffer.alloc(0)),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "guest_read_file",
      arguments: { sourcePath: "big.bin" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { inline: boolean; reason: string; sourcePath: string };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.inline).toBe(false);
    expect(payload.result.reason).toBe("too-large");
    expect(payload.result.sourcePath).toBe("big.bin");
  });

  it("dump_process reports error when script fails", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 1,
          stdoutBase64: "",
          stderrBase64: Buffer.from("access denied").toString("base64"),
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "dump_process",
      arguments: { pid: 1234 },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("access denied");
  });

  it("debug_dump sends minidump command when minidump is true", async () => {
    const commands: Array<{ input: string }> = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok", cdbPath: "cdb.exe" }),
      debugCommand: (_id: string, input: string) => {
        commands.push({ input });
        return Promise.resolve({
          id: "sess-mini",
          outputBase64: Buffer.from("ok").toString("base64"),
          truncated: false,
          logPath: "C:\\log.txt",
          exited: false,
        });
      },
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_dump",
      arguments: { sessionId: "sess-mini", outputGuestPath: "C:\\dump.dmp", minidump: true },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { command: string };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.command).toBe(".dump C:\\dump.dmp");
    expect(commands[0]?.input).toBe(".dump C:\\dump.dmp");
  });

  it("network_set_mode changes mode to capture", async () => {
    const client = await harness({
      config: parseCrucibleConfig({
        vm: { name: "test-vm" },
        network: { mode: "isolated" },
      }),
    });
    const result = (await client.callTool({
      name: "network_set_mode",
      arguments: { mode: "capture" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { requestedMode: string; restartRequired: boolean };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.requestedMode).toBe("capture");
    expect(payload.result.restartRequired).toBe(true);
  });

  it("debug_command reports error when guest client command fails", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok", cdbPath: "C:\\cdb.exe" }),
      debugCommand: () => Promise.reject(new Error("command transport error")),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_command",
      arguments: { sessionId: "sess-err", commands: ["k"] },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("command transport error");
  });

  it("debug_dump reports error when guest client dump fails", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok", cdbPath: "C:\\cdb.exe" }),
      debugCommand: () => Promise.reject(new Error("dump transport error")),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_dump",
      arguments: { sessionId: "sess-err", outputGuestPath: "C:\\dump.dmp" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("dump transport error");
  });

  it("debug_run_script reports error when initial commands cause debugger to exit", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok", cdbPath: "C:\\cdb.exe" }),
      debugOpen: () =>
        Promise.resolve({
          id: "sess-exit",
          pid: 4321,
          logPath: "C:\\log.txt",
          startedAt: "2026-01-01",
        }),
      debugCommand: () =>
        Promise.resolve({
          id: "sess-exit",
          outputBase64: "",
          truncated: false,
          logPath: "C:\\log.txt",
          exited: true,
          exitError: "target crashed during init",
        }),
      debugClose: () => Promise.resolve({ id: "sess-exit", closed: true }),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_run_script",
      arguments: {
        target: { mode: "attach", pid: 1234, initialCommands: ["sxd av"] },
        script: "lm",
      },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("target crashed during init");
  });

  it("classifies CrucibleError codes into appropriate error kinds", async () => {
    // CONFIG_INVALID -> validation
    const client1 = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.reject(new CrucibleError("CONFIG_INVALID", "bad config")),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("unused")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const r1 = (await client1.callTool({ name: "guest_health", arguments: {} })) as ToolCallText;
    expect(parseFirstTextPayload<{ error: { kind: string } }>(r1).error.kind).toBe("validation");

    // QMP_TIMEOUT -> timeout
    const client2 = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.reject(new CrucibleError("QMP_TIMEOUT", "timed out")),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("unused")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const r2 = (await client2.callTool({ name: "guest_health", arguments: {} })) as ToolCallText;
    expect(parseFirstTextPayload<{ error: { kind: string } }>(r2).error.kind).toBe("timeout");

    // policy-denied via message match
    const client3 = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.reject(new Error("access denied by policy")),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("unused")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const r3 = (await client3.callTool({ name: "guest_health", arguments: {} })) as ToolCallText;
    expect(parseFirstTextPayload<{ error: { kind: string } }>(r3).error.kind).toBe("policy-denied");

    // QMP_DISCONNECTED -> vm-offline
    const client4 = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.reject(new CrucibleError("QMP_DISCONNECTED", "disconnected")),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("unused")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const r4 = (await client4.callTool({ name: "guest_health", arguments: {} })) as ToolCallText;
    expect(parseFirstTextPayload<{ error: { kind: string } }>(r4).error.kind).toBe("vm-offline");

    // HOST_PREREQUISITE_MISSING -> host-prerequisite
    const client5 = await harness({
      guestClientFactory: () =>
        Promise.resolve({
          health: () => Promise.reject(new CrucibleError("HOST_PREREQUISITE_MISSING", "missing")),
          exec: () => Promise.reject(new Error("unused")),
          uploadFile: () => Promise.reject(new Error("unused")),
          download: () => Promise.reject(new Error("unused")),
          close: () => Promise.resolve(),
        } as unknown as GuestAgentClient),
    });
    const r5 = (await client5.callTool({ name: "guest_health", arguments: {} })) as ToolCallText;
    expect(parseFirstTextPayload<{ error: { kind: string } }>(r5).error.kind).toBe(
      "host-prerequisite",
    );
  });

  it("debug_dump via injected manager reports error when dump fails", async () => {
    const { DebuggerSessionManager } = await import("@crucible/core");
    const manager = new DebuggerSessionManager({
      run: () => Promise.reject(new Error("cdb crashed")),
      idFactory: () => "dbg-dump-err",
    });
    const client = await harness({ debuggerManager: manager });
    // Open a session first
    manager.open({ mode: "attach", pid: 1234 });
    const result = (await client.callTool({
      name: "debug_dump",
      arguments: { sessionId: "dbg-dump-err", outputGuestPath: "C:\\dump.dmp" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("cdb crashed");
  });

  it("debug_command via injected manager reports error when command fails", async () => {
    const { DebuggerSessionManager } = await import("@crucible/core");
    const manager = new DebuggerSessionManager({
      run: () => Promise.reject(new Error("cdb command crashed")),
      idFactory: () => "dbg-cmd-err",
    });
    const client = await harness({ debuggerManager: manager });
    manager.open({ mode: "attach", pid: 1234 });
    const result = (await client.callTool({
      name: "debug_command",
      arguments: { sessionId: "dbg-cmd-err", commands: ["k"] },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("cdb command crashed");
  });

  it("debug_close reports error when guest client close fails", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      debugClose: () => Promise.reject(new Error("close transport error")),
      exec: () => Promise.reject(new Error("unused")),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "debug_close",
      arguments: { sessionId: "sess-err" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("close transport error");
  });

  it("process_monitor_start reports error when guest exec fails", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 1,
          stdoutBase64: "",
          stderrBase64: Buffer.from("ProcMon not found").toString("base64"),
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "process_monitor_start",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      error: { message: string };
    }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("ProcMon not found");
  });

  it("process_monitor_start returns structured result", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(
            JSON.stringify({
              monitorId: "mon-abc",
              outputGuestPath: "C:\\mon.pml",
              tool: "Procmon64.exe",
            }),
          ).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });

    const result = (await client.callTool({
      name: "process_monitor_start",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: { monitorId: string } }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.monitorId).toBe("mon-abc");
  });

  it("snapshot_list returns empty list", async () => {
    const client = await harness({
      snapshotAdapter: {
        list: () => Promise.resolve([]),
        restore: () => Promise.reject(new Error("no snapshots")),
      },
    });
    const result = (await client.callTool({
      name: "snapshot_list",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: unknown[] }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result).toEqual([]);
  });

  it("process_monitor_status reports not running", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(JSON.stringify({ running: false })).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "process_monitor_status",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { running: boolean };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.running).toBe(false);
  });

  it("process_monitor_status reports running with pid", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(
            JSON.stringify({ running: true, processName: "Procmon64", pid: 1234 }),
          ).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "process_monitor_status",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { running: boolean; processName: string; pid: number };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.running).toBe(true);
    expect(payload.result.pid).toBe(1234);
  });

  it("process_monitor_stop passes targetPid to stop script", async () => {
    let capturedArgs: string[] = [];
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (opts: { arguments?: string[] }) => {
        capturedArgs = opts.arguments ?? [];
        return Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(
            JSON.stringify({ monitorId: "mon-test", events: 0, summary: {} }),
          ).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        });
      },
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    await client.callTool({
      name: "process_monitor_stop",
      arguments: { monitorId: "mon-test", targetPid: 1234 },
    });
    const commandArg = capturedArgs.join(" ");
    expect(commandArg).toContain("$targetPid=1234");
  });

  it("vm_screenshot succeeds with custom outputPath", async () => {
    const client = await harness({
      vmAdapter: {
        status: () => Promise.resolve({ state: "running", pid: 1 }),
        start: () => Promise.resolve({ state: "running", pid: 1 }),
        stop: () => Promise.resolve({ state: "stopped" }),
        screenshot: (outputPath: string) =>
          Promise.resolve({ path: outputPath, sizeBytes: 3072016 }),
      },
    });
    const result = (await client.callTool({
      name: "vm_screenshot",
      arguments: { outputPath: "/tmp/test-capture.ppm" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { path: string; sizeBytes: number };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.path).toBe("/tmp/test-capture.ppm");
    expect(payload.result.sizeBytes).toBe(3072016);
  });

  it("vm_screenshot returns error when screendump fails", async () => {
    const client = await harness({
      vmAdapter: {
        status: () => Promise.resolve({ state: "running", pid: 1 }),
        start: () => Promise.resolve({ state: "running", pid: 1 }),
        stop: () => Promise.resolve({ state: "stopped" }),
        screenshot: () => Promise.reject(new Error("QMP screendump failed")),
      },
    });
    const result = (await client.callTool({
      name: "vm_screenshot",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("QMP screendump failed");
  });

  it("vm_screenshot uses default path when outputPath omitted", async () => {
    let capturedPath = "";
    const client = await harness({
      vmAdapter: {
        status: () => Promise.resolve({ state: "running", pid: 1 }),
        start: () => Promise.resolve({ state: "running", pid: 1 }),
        stop: () => Promise.resolve({ state: "stopped" }),
        screenshot: (outputPath: string) => {
          capturedPath = outputPath;
          return Promise.resolve({ path: outputPath, sizeBytes: 100 });
        },
      },
    });
    const result = (await client.callTool({
      name: "vm_screenshot",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
    expect(capturedPath).toContain("artifacts/screenshots/screenshot-");
  });

  it("process_monitor_status handles empty stdout", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          stdoutBase64: "",
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      uploadFile: () =>
        Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      guestClientFactory: () => Promise.resolve(fakeClient as unknown as GuestAgentClient),
    });
    const result = (await client.callTool({
      name: "process_monitor_status",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("no output");
  });

  it("network_set_mode persists mode to config file", async () => {
    const dir = await createTempDir("crucible-mcp-netcfg-");
    const configPath = path.join(dir, "crucible.config.json");
    const configData = {
      vm: { name: "persist-vm" },
      network: { mode: "isolated" },
    };
    await writeFile(configPath, JSON.stringify(configData, null, 2), "utf8");
    const client = await harness({
      config: parseCrucibleConfig(configData),
      configPath,
    });

    const result = (await client.callTool({
      name: "network_set_mode",
      arguments: { mode: "nat" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { applied: boolean; configPath: string };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.applied).toBe(true);

    const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
      network: { mode: string };
    };
    expect(persisted.network.mode).toBe("nat");

    // Subsequent network_status should reflect the new mode
    const statusResult = (await client.callTool({
      name: "network_status",
      arguments: {},
    })) as ToolCallText;
    const status = parseFirstTextPayload<{
      ok: boolean;
      result: { configuredMode: string };
    }>(statusResult);
    expect(status.result.configuredMode).toBe("nat");
  });

  it("network_set_mode without configPath still updates in-memory mode", async () => {
    const client = await harness({
      config: parseCrucibleConfig({
        vm: { name: "mem-vm" },
        network: { mode: "isolated" },
      }),
    });

    await client.callTool({
      name: "network_set_mode",
      arguments: { mode: "nat" },
    });

    const statusResult = (await client.callTool({
      name: "network_status",
      arguments: {},
    })) as ToolCallText;
    const status = parseFirstTextPayload<{
      ok: boolean;
      result: { configuredMode: string };
    }>(statusResult);
    expect(status.result.configuredMode).toBe("nat");
  });

  it("network_set_mode returns applied: true", async () => {
    const client = await harness({
      config: parseCrucibleConfig({
        vm: { name: "applied-vm" },
        network: { mode: "isolated" },
      }),
    });

    const result = (await client.callTool({
      name: "network_set_mode",
      arguments: { mode: "capture" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { applied: boolean };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.applied).toBe(true);
  });

  it("network_set_mode rejects invalid config JSON without mutating in-memory mode", async () => {
    const dir = await createTempDir("crucible-mcp-netcfg-bad-");
    const configPath = path.join(dir, "crucible.config.json");
    await writeFile(configPath, "{ not-json", "utf8");
    const client = await harness({
      config: parseCrucibleConfig({
        vm: { name: "bad-config-vm" },
        network: { mode: "isolated" },
      }),
      configPath,
    });

    const result = (await client.callTool({
      name: "network_set_mode",
      arguments: { mode: "nat" },
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; error: { message: string } }>(result);
    expect(payload.ok).toBe(false);

    const statusResult = (await client.callTool({
      name: "network_status",
      arguments: {},
    })) as ToolCallText;
    const status = parseFirstTextPayload<{ result: { configuredMode: string } }>(statusResult);
    expect(status.result.configuredMode).toBe("isolated");
    await expect(readFile(configPath, "utf8")).resolves.toBe("{ not-json");
  });
});
