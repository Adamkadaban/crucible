import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

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

describe.runIf(liveConfigured)("MCP tools against the live guest agent (env-gated)", () => {
  async function client(): Promise<Client> {
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
    const c = new Client({ name: "crucible-it", version: "0.0.0" });
    await c.connect(clientTransport);
    return c;
  }

  it("guest_health reports status:ok from the live agent", async () => {
    const c = await client();
    const result = (await c.callTool({ name: "guest_health", arguments: {} })) as ToolCallText;
    const payload = parsePayload<{ ok: boolean; result: { status: string } }>(result);
    expect(payload.ok).toBe(true);
    expect(payload.result.status).toBe("ok");
  });

  it("guest_exec round-trips whoami.exe and returns the SYSTEM identity", async () => {
    const c = await client();
    const result = (await c.callTool({
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

  it("guest_upload + guest_download round-trip a payload via staging", async () => {
    const c = await client();
    const payload = Buffer.from(`crucible-mcp-it-${Date.now()}`);
    const targetPath = `mcp-it-${Date.now()}.bin`;

    const upload = (await c.callTool({
      name: "guest_upload",
      arguments: {
        targetPath,
        contentsBase64: payload.toString("base64"),
      },
    })) as ToolCallText;
    const uploadResp = parsePayload<{
      ok: boolean;
      result: { sizeBytes: number; sha256: string };
    }>(upload);
    expect(uploadResp.ok).toBe(true);
    expect(uploadResp.result.sizeBytes).toBe(payload.byteLength);

    const download = (await c.callTool({
      name: "guest_download",
      arguments: { sourcePath: targetPath },
    })) as ToolCallText;
    const downloadResp = parsePayload<{ ok: boolean; result: { contentsBase64: string } }>(
      download,
    );
    expect(downloadResp.ok).toBe(true);
    expect(Buffer.from(downloadResp.result.contentsBase64, "base64").equals(payload)).toBe(true);
  });
});
