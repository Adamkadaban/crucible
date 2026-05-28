import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Buffer } from "node:buffer";

import {
  BOOTSTRAP_TOOLS,
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
  it("exposes the bootstrap registration via getMcpServerBanner", () => {
    expect(getMcpServerBanner()).toMatch(/^crucible MCP server /);
    expect(BOOTSTRAP_TOOLS.map((tool) => tool.name)).toEqual([
      "host_check",
      "guest_health",
      "guest_exec",
      "guest_upload",
      "guest_download",
    ]);
  });

  it("invokes host_check with the injected probe", async () => {
    const client = await harness({
      hostCheck: () => Promise.resolve({ healthy: false, missing: ["qemu"] as readonly string[] }),
    });
    const result = (await client.callTool({ name: "host_check", arguments: {} })) as ToolCallText;
    const payload = parseFirstTextPayload<{ ok: boolean; result: { missing: string[] } }>(result);
    expect(payload.ok).toBe(false);
    expect(payload.result.missing).toEqual(["qemu"]);
  });

  it("reports guest-failed when the guest client is missing", async () => {
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

  it("round-trips guest_exec through a fake guest client", async () => {
    const fakeClient = {
      health: () => Promise.resolve({ status: "ok" }),
      exec: (req: { executable: string; arguments?: string[] }) =>
        Promise.resolve({
          exitCode: 0,
          stdoutBase64: Buffer.from(`ran ${req.executable}`).toString("base64"),
          stderrBase64: "",
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }),
      upload: () => Promise.resolve({ path: "C:\\stage\\foo", sizeBytes: 4, sha256: "deadbeef" }),
      download: () => Promise.resolve(Buffer.from("downloaded")),
      close: () => Promise.resolve(),
    };
    const client = await harness({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      guestClientFactory: () => Promise.resolve(fakeClient as any),
    });
    const exec = (await client.callTool({
      name: "guest_exec",
      arguments: { executable: "whoami.exe", arguments: ["/groups"] },
    })) as ToolCallText;
    const execPayload = parseFirstTextPayload<{
      ok: boolean;
      result: { stdoutBase64: string };
    }>(exec);
    expect(execPayload.ok).toBe(true);
    expect(Buffer.from(execPayload.result.stdoutBase64, "base64").toString()).toBe(
      "ran whoami.exe",
    );

    const upload = (await client.callTool({
      name: "guest_upload",
      arguments: {
        targetPath: "stage/payload.bin",
        contentsBase64: Buffer.from("data").toString("base64"),
      },
    })) as ToolCallText;
    expect(
      parseFirstTextPayload<{ ok: boolean; result: { sizeBytes: number } }>(upload).result
        .sizeBytes,
    ).toBe(4);

    const download = (await client.callTool({
      name: "guest_download",
      arguments: { sourcePath: "stage/payload.bin" },
    })) as ToolCallText;
    const dlPayload = parseFirstTextPayload<{ ok: boolean; result: { contentsBase64: string } }>(
      download,
    );
    expect(Buffer.from(dlPayload.result.contentsBase64, "base64").toString()).toBe("downloaded");
  });

  it("returns isError when guest_exec input fails Zod validation", async () => {
    const client = await harness({});
    const result = (await client.callTool({
      name: "guest_exec",
      arguments: { arguments: ["whoami"] },
    })) as ToolCallText & { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("createCrucibleMcpServer registers exactly the bootstrap tool set", () => {
    const server = createCrucibleMcpServer({});
    // Re-registering throws by SDK contract; ensures the bootstrap set is
    // installed once and avoids duplicate registrations across callers.
    expect(() => registerCrucibleTools({ server })).toThrow(/already registered/i);
  });
});
