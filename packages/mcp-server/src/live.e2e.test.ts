import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { buildGuestAgentClientFromFiles, createCrucibleMcpServer } from "./index.js";

const liveEnabled = process.env.CRUCIBLE_E2E_LIVE === "1";
const baseUrl = process.env.CRUCIBLE_GUEST_BASE_URL;
const caPath = process.env.CRUCIBLE_GUEST_CA_PATH;
const certPath = process.env.CRUCIBLE_GUEST_CERT_PATH;
const keyPath = process.env.CRUCIBLE_GUEST_KEY_PATH;

const configured =
  liveEnabled &&
  baseUrl !== undefined &&
  caPath !== undefined &&
  certPath !== undefined &&
  keyPath !== undefined;

type ToolCallText = { content: ReadonlyArray<{ type: string; text: string }> };
type LiveHarness = { readonly client: Client; readonly close: () => Promise<void> };

const harnesses: LiveHarness[] = [];

afterAll(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

function parsePayload<T>(result: ToolCallText): T {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("missing MCP text payload");
  return JSON.parse(text) as T;
}

async function liveHarness(): Promise<LiveHarness> {
  const guest = await buildGuestAgentClientFromFiles({
    baseUrl: baseUrl!,
    caPath: caPath!,
    clientCertificatePath: certPath!,
    clientPrivateKeyPath: keyPath!,
    timeoutMs: 60_000,
  });
  const server = createCrucibleMcpServer({ guestClientFactory: () => Promise.resolve(guest) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "crucible-live-e2e", version: "0.0.0" });
  await client.connect(clientTransport);
  const harness = {
    client,
    close: async () => {
      await client.close();
      await server.close();
      await guest.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

describe.runIf(configured)("Crucible live MCP E2E (env-gated)", () => {
  it("repeats guest health, exec, and file round trips over the MCP protocol", async () => {
    const { client } = await liveHarness();
    for (let i = 0; i < 3; i += 1) {
      const health = parsePayload<{ ok: boolean; result: { status: string } }>(
        (await client.callTool({ name: "guest_health", arguments: {} })) as ToolCallText,
      );
      expect(health).toMatchObject({ ok: true, result: { status: "ok" } });

      const exec = parsePayload<{
        ok: boolean;
        result: { exitCode: number; stdoutBase64?: string };
      }>(
        (await client.callTool({
          name: "guest_exec",
          arguments: { executable: "C:\\Windows\\System32\\whoami.exe", timeoutMs: 10_000 },
        })) as ToolCallText,
      );
      expect(exec.ok).toBe(true);
      expect(exec.result.exitCode).toBe(0);
      expect(
        Buffer.from(exec.result.stdoutBase64 ?? "", "base64")
          .toString()
          .trim().length,
      ).toBeGreaterThan(0);

      const tempDir = await mkdtemp(path.join(tmpdir(), "crucible-live-e2e-"));
      try {
        const contents = `live-e2e-${i}-${Date.now()}\n`;
        const hostPath = path.join(tempDir, "payload.txt");
        const guestPath = `live-e2e-${i}.txt`;
        await writeFile(hostPath, contents, "ascii");
        const upload = parsePayload<{ ok: boolean }>(
          (await client.callTool({
            name: "guest_upload_file",
            arguments: { hostPath, guestPath },
          })) as ToolCallText,
        );
        expect(upload.ok).toBe(true);
        const read = parsePayload<{ ok: boolean; result: { inline: boolean; contents: string } }>(
          (await client.callTool({
            name: "guest_read_file",
            arguments: { sourcePath: guestPath },
          })) as ToolCallText,
        );
        expect(read.result).toMatchObject({ inline: true, contents });
        const downloadPath = path.join(tempDir, "downloaded.txt");
        const download = parsePayload<{ ok: boolean }>(
          (await client.callTool({
            name: "guest_download_file",
            arguments: { guestPath, hostPath: downloadPath },
          })) as ToolCallText,
        );
        expect(download.ok).toBe(true);
        await expect(readFile(downloadPath, "ascii")).resolves.toBe(contents);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });
});
