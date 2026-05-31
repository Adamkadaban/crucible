import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { parseCrucibleConfig, type GuestAgentClient } from "@crucible/core";

import {
  BOOTSTRAP_TOOLS,
  cacheGuestClientFactory,
  createCrucibleMcpServer,
  getMcpServerBanner,
  registerCrucibleTools,
} from "./index.js";

type ToolCallText = { content: ReadonlyArray<{ type: string; text: string }> };

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

  it("reports pcap info when capture path is configured", async () => {
    const pcapPath = `artifacts/downloads/mcp-pcap-${Date.now()}.pcap`;
    await mkdir(path.dirname(pcapPath), { recursive: true });
    await writeFile(pcapPath, Buffer.from("pcap"));
    const client = await harness({
      config: parseCrucibleConfig({
        vm: { name: "capture-vm" },
        network: { mode: "capture", pcapPath },
      }),
    });

    const result = (await client.callTool({
      name: "network_pcap_info",
      arguments: {},
    })) as ToolCallText;
    const payload = parseFirstTextPayload<{
      ok: boolean;
      result: { pcapPath?: string; exists: boolean; sizeBytes?: number };
    }>(result);

    expect(payload.result).toMatchObject({ pcapPath, exists: true, sizeBytes: 4 });
    await rm(pcapPath, { force: true });
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
    const execRequests: Array<{ executable: string; as?: string }> = [];
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
        arguments: { executable: "whoami.exe" },
      });
    }
    await client.callTool({
      name: "guest_exec_admin",
      arguments: { executable: "whoami.exe" },
    });
    expect(factoryCalls).toBe(1);
    expect(execRequests.map((req) => req.as)).toEqual(["service", "service", "service", "admin"]);
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

  it("returns isError when guest_exec input fails Zod validation", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "guest_exec",
      arguments: { arguments: ["whoami"] },
    })) as ToolCallText & { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("uploads an existing host file through guest_upload_file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crucible-mcp-upload-"));
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
});
