import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GuestAgentClient } from "@crucible/core";

import { buildGuestAgentClientFromFiles, createCrucibleMcpServer } from "./index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const baseUrl = process.env.CRUCIBLE_GUEST_BASE_URL;
const caPath = process.env.CRUCIBLE_GUEST_CA_PATH;
const certPath = process.env.CRUCIBLE_GUEST_CERT_PATH;
const keyPath = process.env.CRUCIBLE_GUEST_KEY_PATH;

const liveConfigured =
  baseUrl !== undefined && caPath !== undefined && certPath !== undefined && keyPath !== undefined;

type ToolCallText = { content: ReadonlyArray<{ type: string; text: string }> };
function parsePayload<T>(result: ToolCallText): T {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("missing text content");
  return JSON.parse(text) as T;
}

type LiveHarness = {
  readonly mcp: Client;
  readonly guest: GuestAgentClient;
  readonly close: () => Promise<void>;
};
const activeHarnesses: LiveHarness[] = [];

afterAll(async () => {
  // Drain every harness we opened so Vitest doesn't hang on leaked
  // undici sockets / MCP transports.
  for (const harness of activeHarnesses) {
    await harness.close();
  }
});

describe.runIf(liveConfigured)("MCP tools against the live guest agent (env-gated)", () => {
  async function harness(): Promise<LiveHarness> {
    const guest: GuestAgentClient = await buildGuestAgentClientFromFiles({
      baseUrl: baseUrl!,
      caPath: caPath!,
      clientCertificatePath: certPath!,
      clientPrivateKeyPath: keyPath!,
      timeoutMs: 10_000,
    });
    const server = createCrucibleMcpServer({
      guestClientFactory: () => Promise.resolve(guest),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "crucible-it", version: "0.0.0" });
    await mcp.connect(clientTransport);
    const h: LiveHarness = {
      mcp,
      guest,
      close: async () => {
        await mcp.close();
        await server.close();
        await guest.close();
      },
    };
    activeHarnesses.push(h);
    return h;
  }

  it("guest_health reports status:ok from the live agent", async () => {
    const { mcp } = await harness();
    const result = (await mcp.callTool({ name: "guest_health", arguments: {} })) as ToolCallText;
    const payload = parsePayload<{ ok: boolean; result: { status: string } }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.status).toBe("ok");
  });

  it("guest_exec round-trips whoami.exe and returns the SYSTEM identity", async () => {
    const { mcp } = await harness();
    const result = (await mcp.callTool({
      name: "guest_exec",
      arguments: {
        executable: "C:\\Windows\\System32\\whoami.exe",
        timeoutMs: 5000,
      },
    })) as ToolCallText;
    const payload = parsePayload<{
      ok: boolean;
      result: { exitCode: number; stdoutBase64?: string };
    }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.exitCode).toBe(0);
    const stdout = Buffer.from(payload.result.stdoutBase64 ?? "", "base64").toString();
    expect(stdout.toLowerCase()).toContain("nt authority\\system");
  });

  it("guest_upload_file + guest_read_file round-trip ASCII via staging", async () => {
    const { mcp } = await harness();
    const payload = `crucible-mcp-it-${Date.now()}\n`;
    const targetPath = `mcp-it-${Date.now()}.txt`;
    const dir = await mkdtemp(path.join(tmpdir(), "crucible-mcp-it-"));
    const hostPath = path.join(dir, "payload.txt");
    await writeFile(hostPath, payload, "ascii");

    try {
      const upload = (await mcp.callTool({
        name: "guest_upload_file",
        arguments: { hostPath, guestPath: targetPath },
      })) as ToolCallText;
      const uploadResp = parsePayload<{
        ok: boolean;
        result: { sizeBytes: number; sha256: string };
      }>(upload);
      expect(uploadResp.ok).toBe(true);
      expect(uploadResp.result.sizeBytes).toBe(Buffer.byteLength(payload, "ascii"));

      const read = (await mcp.callTool({
        name: "guest_read_file",
        arguments: { sourcePath: targetPath },
      })) as ToolCallText;
      const readResp = parsePayload<{ ok: boolean; result: { inline: boolean; contents: string } }>(
        read,
      );
      expect(readResp.ok).toBe(true);
      expect(readResp.result).toMatchObject({ inline: true, contents: payload });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
