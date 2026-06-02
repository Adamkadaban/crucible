import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseCrucibleConfig, type GuestAgentClient } from "@crucible/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCrucibleMcpServer,
  type CrucibleSnapshotAdapter,
  type CrucibleVmAdapter,
} from "./index.js";

type ToolCallText = { content: ReadonlyArray<{ type: string; text: string }> };
type ExecRequest = Parameters<GuestAgentClient["exec"]>[0];

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function parsePayload<T>(result: ToolCallText): T {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("missing MCP text payload");
  return JSON.parse(text) as T;
}

async function mcpHarness(options: Parameters<typeof createCrucibleMcpServer>[0]) {
  const server = createCrucibleMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "crucible-e2e", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function makeE2eGuestClient(root: string, execRequests: ExecRequest[]): GuestAgentClient {
  const guestFiles = new Map<string, Buffer>();
  const jsonExec = (payload: unknown) => ({
    exitCode: 0,
    stdoutBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
    stderrBase64: "",
    timedOut: false,
    durationMs: 5,
    truncated: false,
  });
  return {
    health: () =>
      Promise.resolve({
        status: "ok",
        version: "e2e",
        hostname: "CRUCIBLE-E2E",
        uptimeSeconds: 123,
        timeUtc: "2026-06-02T00:00:00.000Z",
        features: ["exec", "files", "debug", "memory"],
      }),
    exec: (request: ExecRequest) => {
      execRequests.push(request);
      const script = request.arguments?.join(" ") ?? "";
      if (script.includes("ProcMon capture is global")) {
        return Promise.resolve(jsonExec({ monitorId: "mon-e2e", outputGuestPath: "C:\\mon.pml" }));
      }
      if (script.includes("ProcMon status check")) {
        return Promise.resolve(jsonExec({ running: false }));
      }
      if (script.includes("eventsCaptured")) {
        return Promise.resolve(jsonExec({ monitorId: "mon-e2e", eventsCaptured: 0 }));
      }
      if (script.includes("[CrucibleMemory]::Scan")) {
        return Promise.resolve(jsonExec({ pid: 4321, matches: [] }));
      }
      if (script.includes("[CrucibleMemory]::DumpRegion")) {
        return Promise.resolve(
          jsonExec({ pid: 4321, outputGuestPath: "C:\\dump.bin", bytesWritten: 16 }),
        );
      }
      if (
        script.includes("dumpPath") ||
        script.includes("ProcDump") ||
        script.includes("MiniDump")
      ) {
        return Promise.resolve(
          jsonExec({ pid: 4321, outputGuestPath: "C:\\proc.dmp", method: "auto" }),
        );
      }
      return Promise.resolve({
        exitCode: 0,
        stdoutBase64: Buffer.from(`ran:${request.executable}:${request.as ?? "service"}`).toString(
          "base64",
        ),
        stderrBase64: "",
        timedOut: false,
        durationMs: 5,
        truncated: false,
      });
    },
    uploadFile: async (hostPath: string, guestPath: string) => {
      const data = await readFile(hostPath);
      guestFiles.set(guestPath, data);
      return { guestPath, sizeBytes: data.byteLength, sha256: "sha256-upload" };
    },
    inspect: (sourcePath: string) => {
      const data = guestFiles.get(sourcePath) ?? Buffer.from("missing");
      return Promise.resolve({
        sourcePath,
        sizeBytes: data.byteLength,
        isAsciiText: true,
        sha256: "sha256-inspect",
      });
    },
    download: (sourcePath: string) =>
      Promise.resolve(guestFiles.get(sourcePath) ?? Buffer.from("missing")),
    downloadFile: async (guestPath: string, hostPath: string) => {
      const data = guestFiles.get(guestPath) ?? Buffer.from("downloaded");
      await mkdir(path.dirname(hostPath), { recursive: true });
      await writeFile(hostPath, data);
      return { hostPath, sizeBytes: data.byteLength, sha256: "sha256-download" };
    },
    debugOpen: () =>
      Promise.resolve({ id: "dbg-e2e", pid: 4321, startedAt: "2026-06-02T00:00:00.000Z" }),
    debugCommand: (_sessionId: string, command: string) =>
      Promise.resolve({
        outputBase64: Buffer.from(`debug:${command}`).toString("base64"),
        exitCode: 0,
        exited: false,
        truncated: false,
        logPath: "C:\\debug.log",
      }),
    debugClose: (sessionId: string) => Promise.resolve({ id: sessionId, closed: true }),
    close: () => Promise.resolve(),
    // Keep the cast local to this fake; E2E calls below only need the methods above.
  } as unknown as GuestAgentClient;
}

describe("Crucible MCP protocol E2E", () => {
  it("runs a provisioned-VM workflow through MCP tool calls with injected adapters", async () => {
    const root = await createTempDir("crucible-mcp-e2e-");
    const execRequests: ExecRequest[] = [];
    const vmEvents: string[] = [];
    const vm: CrucibleVmAdapter = {
      status: () => Promise.resolve({ state: "stopped" }),
      start: () => {
        vmEvents.push("start");
        return Promise.resolve({ state: "running", pid: 1234 });
      },
      stop: () => {
        vmEvents.push("stop");
        return Promise.resolve({ state: "stopped" });
      },
      screenshot: (outputPath) => Promise.resolve({ path: outputPath, sizeBytes: 4096 }),
      displayInfo: () => Promise.resolve({ available: true, inputAvailable: true, backend: "e2e" }),
      mouseMove: (x, y) => Promise.resolve({ action: "mouse_move", x, y }),
      mouseClick: (input) => Promise.resolve({ action: "mouse_click", ...input }),
      mouseDoubleClick: (input) => Promise.resolve({ action: "mouse_double_click", ...input }),
      mouseDrag: (input) =>
        Promise.resolve({ action: "mouse_drag", x: input.toX, y: input.toY, button: input.button }),
      keyPress: (key) => Promise.resolve({ action: "key_press", key }),
      typeText: (text) => Promise.resolve({ action: "type_text", textLength: text.length }),
    };
    const snapshots: CrucibleSnapshotAdapter = {
      list: () =>
        Promise.resolve([{ name: "clean-base", path: "snapshots/clean-base", createdAt: "now" }]),
      restore: (snapshotName) =>
        Promise.resolve({
          name: snapshotName,
          path: `snapshots/${snapshotName}`,
          createdAt: "now",
        }),
    };
    const configPath = path.join(root, "crucible.config.json");
    await writeFile(configPath, JSON.stringify({ network: { mode: "isolated" } }), "utf8");
    const guestClient = makeE2eGuestClient(root, execRequests);

    const { client, server } = await mcpHarness({
      config: parseCrucibleConfig({
        vm: { name: "e2e-vm" },
        artifacts: { directory: path.join(root, "artifacts") },
        network: { mode: "isolated" },
      }),
      configPath,
      hostCheck: () =>
        Promise.resolve({
          healthy: true,
          missing: [],
          notes: "ok",
          platform: "linux",
          arch: "x64",
        }),
      guestClientFactory: () => Promise.resolve(guestClient),
      vmAdapter: vm,
      snapshotAdapter: snapshots,
    });

    try {
      const host = parsePayload<{ ok: boolean }>(
        (await client.callTool({ name: "host_check", arguments: {} })) as ToolCallText,
      );
      const start = parsePayload<{ ok: boolean; result: { state: string } }>(
        (await client.callTool({ name: "vm_start", arguments: {} })) as ToolCallText,
      );
      const restore = parsePayload<{ ok: boolean; result: { name: string } }>(
        (await client.callTool({
          name: "snapshot_restore",
          arguments: { snapshotName: "clean-base" },
        })) as ToolCallText,
      );
      const display = parsePayload<{ ok: boolean; result: { backend: string } }>(
        (await client.callTool({ name: "vm_display_info", arguments: {} })) as ToolCallText,
      );
      await client.callTool({ name: "vm_mouse_move", arguments: { x: 100, y: 200 } });
      await client.callTool({ name: "vm_mouse_click", arguments: { button: "left" } });
      await client.callTool({ name: "vm_mouse_double_click", arguments: { x: 1, y: 2 } });
      await client.callTool({
        name: "vm_mouse_drag",
        arguments: { fromX: 1, fromY: 2, toX: 3, toY: 4 },
      });
      await client.callTool({ name: "vm_key_press", arguments: { key: "ctrl-l" } });
      await client.callTool({ name: "vm_type_text", arguments: { text: "echo e2e_+\r\n" } });
      const screenshot = parsePayload<{ ok: boolean; result: { sizeBytes: number } }>(
        (await client.callTool({
          name: "vm_screenshot",
          arguments: { outputPath: "screen.ppm" },
        })) as ToolCallText,
      );
      const health = parsePayload<{ ok: boolean; result: { status: string } }>(
        (await client.callTool({ name: "guest_health", arguments: {} })) as ToolCallText,
      );
      const exec = parsePayload<{ ok: boolean; result: { stdoutBase64: string } }>(
        (await client.callTool({
          name: "guest_exec",
          arguments: { executable: "whoami.exe", arguments: ["/user"] },
        })) as ToolCallText,
      );
      const adminExec = parsePayload<{ ok: boolean }>(
        (await client.callTool({
          name: "guest_exec_admin",
          arguments: { executable: "whoami.exe" },
        })) as ToolCallText,
      );
      const hostPayload = path.join(root, "payload.txt");
      const hostDownload = "artifacts/downloads/mcp-e2e-payload.txt";
      await writeFile(hostPayload, "mcp-e2e\n", "ascii");
      await client.callTool({
        name: "guest_upload_file",
        arguments: { hostPath: hostPayload, guestPath: "C:\\payload.txt" },
      });
      const read = parsePayload<{ ok: boolean; result: { inline: boolean; contents: string } }>(
        (await client.callTool({
          name: "guest_read_file",
          arguments: { sourcePath: "C:\\payload.txt" },
        })) as ToolCallText,
      );
      const download = parsePayload<{ ok: boolean; result: { sizeBytes: number } }>(
        (await client.callTool({
          name: "guest_download_file",
          arguments: { guestPath: "C:\\payload.txt", hostPath: hostDownload },
        })) as ToolCallText,
      );
      const network = parsePayload<{ ok: boolean; result: { requestedMode: string } }>(
        (await client.callTool({
          name: "network_set_mode",
          arguments: { mode: "nat" },
        })) as ToolCallText,
      );
      const dump = parsePayload<{ ok: boolean; result: { outputGuestPath: string } }>(
        (await client.callTool({ name: "dump_process", arguments: { pid: 4321 } })) as ToolCallText,
      );
      const monitor = parsePayload<{ ok: boolean; result: { monitorId: string } }>(
        (await client.callTool({
          name: "process_monitor_start",
          arguments: { targetPid: 4321 },
        })) as ToolCallText,
      );
      await client.callTool({ name: "process_monitor_status", arguments: {} });
      await client.callTool({
        name: "process_monitor_stop",
        arguments: { monitorId: monitor.result.monitorId },
      });
      const memory = parsePayload<{ ok: boolean; result: { pid: number } }>(
        (await client.callTool({
          name: "memory_scan",
          arguments: { pid: 4321, patterns: ["mcp-e2e"] },
        })) as ToolCallText,
      );
      const debugOpen = parsePayload<{ ok: boolean; result: { id: string } }>(
        (await client.callTool({
          name: "debug_open",
          arguments: { mode: "attach", pid: 4321 },
        })) as ToolCallText,
      );
      const debugCommand = parsePayload<{ ok: boolean; result: { stdoutBase64: string } }>(
        (await client.callTool({
          name: "debug_command",
          arguments: { sessionId: debugOpen.result.id, commands: ["lm"] },
        })) as ToolCallText,
      );
      await client.callTool({
        name: "debug_dump",
        arguments: { sessionId: debugOpen.result.id, outputGuestPath: "C:\\debug.dmp" },
      });
      await client.callTool({ name: "debug_close", arguments: { sessionId: debugOpen.result.id } });
      await client.callTool({ name: "vm_stop", arguments: {} });

      expect(host.ok).toBe(true);
      expect(start.result.state).toBe("running");
      expect(restore.result.name).toBe("clean-base");
      expect(display.result.backend).toBe("e2e");
      expect(screenshot.result.sizeBytes).toBe(4096);
      expect(health.result.status).toBe("ok");
      expect(Buffer.from(exec.result.stdoutBase64, "base64").toString()).toContain("service");
      expect(adminExec.ok).toBe(true);
      expect(read.result).toMatchObject({ inline: true, contents: "mcp-e2e\n" });
      expect(download.result.sizeBytes).toBe(8);
      expect(network.result.requestedMode).toBe("nat");
      expect(dump.result.outputGuestPath).toBe("C:\\proc.dmp");
      expect(memory.result.pid).toBe(4321);
      expect(Buffer.from(debugCommand.result.stdoutBase64, "base64").toString()).toContain("lm");
      expect(vmEvents).toEqual(["start", "stop"]);
      expect(execRequests.some((request) => request.as === "admin")).toBe(true);
    } finally {
      await rm("artifacts/downloads/mcp-e2e-payload.txt", { force: true });
      await client.close();
      await server.close();
    }
  });
});
