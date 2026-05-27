import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CrucibleError } from "./errors.js";
import { parseQmpMessage, QmpClient } from "./qmp.js";

class ThrowingWriteQmpClient extends QmpClient {
  failNextWrite = false;

  protected override writeToSocket(data: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("write failed");
    }
    super.writeToSocket(data);
  }
}

const capturedGreeting = {
  QMP: {
    version: {
      qemu: { major: 8, minor: 2, micro: 0 },
      package: "qemu-8.2.0",
    },
    capabilities: ["oob"],
  },
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("QmpClient", () => {
  it("negotiates the greeting and qmp_capabilities command", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) => {
        connection.send({ return: {}, id: request.id });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });

    await expect(client.connect()).resolves.toEqual(capturedGreeting.QMP);
    expect(server.requests).toEqual([{ execute: "qmp_capabilities", id: "crucible-1" }]);

    client.close();
    await server.close();
  });

  it("allows retry after a transient connection failure", async () => {
    const socketPath = path.join(await createTempDir(), "qmp.sock");
    const client = new QmpClient({ socketPath, timeoutMs: 200 });

    await expect(client.connect()).rejects.toMatchObject({
      code: "QMP_CONNECTION_FAILED",
      details: { code: "ENOENT" },
    });

    const server = await createFakeQmpServerAt(socketPath, (connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) => {
        connection.send({ return: {}, id: request.id });
      });
    });

    await expect(client.connect()).resolves.toEqual(capturedGreeting.QMP);

    client.close();
    await server.close();
  });

  it("memoizes concurrent connect calls during greeting negotiation", async () => {
    const sendGreeting: Array<() => void> = [];
    const server = await createFakeQmpServer((connection) => {
      sendGreeting.push(() => connection.send(capturedGreeting));
      connection.onCommand("qmp_capabilities", (request) => {
        connection.send({ return: {}, id: request.id });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    const firstConnect = client.connect();
    const secondConnect = client.connect();

    await waitFor(() => sendGreeting.length === 1);
    sendGreeting[0]?.();

    await expect(Promise.all([firstConnect, secondConnect])).resolves.toEqual([
      capturedGreeting.QMP,
      capturedGreeting.QMP,
    ]);
    expect(server.requests).toEqual([{ execute: "qmp_capabilities", id: "crucible-1" }]);

    client.close();
    await server.close();
  });

  it("queues execute calls behind in-flight connect readiness", async () => {
    const sendGreeting: Array<() => void> = [];
    const server = await createFakeQmpServer((connection) => {
      sendGreeting.push(() => connection.send(capturedGreeting));
      connection.onCommand("qmp_capabilities", (request) => {
        connection.send({ return: {}, id: request.id });
      });
      connection.onCommand("query-status", (request) => {
        connection.send({ return: { status: "running" }, id: request.id });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    const connect = client.connect();
    const command = client.execute("query-status");

    await waitFor(() => sendGreeting.length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(server.requests).toEqual([]);
    sendGreeting[0]?.();

    await expect(connect).resolves.toEqual(capturedGreeting.QMP);
    await expect(command).resolves.toMatchObject({ returnValue: { status: "running" } });
    expect(server.requests.map((request) => request.execute)).toEqual([
      "qmp_capabilities",
      "query-status",
    ]);

    client.close();
    await server.close();
  });

  it("rejects execute calls before connect starts", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
    });
    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });

    await expect(client.execute("query-status")).rejects.toMatchObject({
      code: "QMP_DISCONNECTED",
    });

    client.close();
    await server.close();
  });

  it("sends command arguments with request IDs and collects events", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-status", (request) => {
        connection.send({
          event: "STOP",
          data: { reason: "debug" },
          timestamp: { seconds: 1, microseconds: 2 },
        });
        connection.send({ return: { status: "paused", running: false }, id: request.id });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    const result = await client.execute<{ status: string; running: boolean }>(
      "query-status",
      { verbose: true },
      { id: "status-1" },
    );

    expect(result).toEqual({
      id: "status-1",
      returnValue: { status: "paused", running: false },
      events: [
        { event: "STOP", data: { reason: "debug" }, timestamp: { seconds: 1, microseconds: 2 } },
      ],
    });
    expect(server.requests.at(-1)).toEqual({
      execute: "query-status",
      arguments: { verbose: true },
      id: "status-1",
    });

    client.close();
    await server.close();
  });

  it("rejects drainEvents while a command is pending", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-block", () => {
        connection.send({ event: "BLOCK_JOB_READY" });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    const command = client.execute("query-block", undefined, { timeoutMs: 50 });
    await waitFor(() => server.requests.some((request) => request.execute === "query-block"));

    expect(() => client.drainEvents()).toThrow(
      /cannot drain QMP events while commands are pending/,
    );
    await expect(command).rejects.toMatchObject({ code: "QMP_TIMEOUT" });

    client.close();
    await server.close();
  });

  it("does not attribute events received after a response in the same buffer", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-status", (request) => {
        connection.sendMany([
          { event: "STOP", data: { reason: "debug" } },
          { return: { status: "paused" }, id: request.id },
          { event: "RESUME" },
        ]);
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("query-status")).resolves.toMatchObject({
      events: [{ event: "STOP", data: { reason: "debug" } }],
    });
    expect(client.drainEvents()).toEqual([{ event: "RESUME" }]);

    client.close();
    await server.close();
  });

  it("returns structured QMP command errors", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("stop", (request) => {
        connection.send({
          error: { class: "GenericError", desc: "VM is not running" },
          id: request.id,
        });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("stop")).rejects.toMatchObject({
      code: "QMP_COMMAND_FAILED",
      message: "VM is not running",
      details: { qmpClass: "GenericError" },
    });

    client.close();
    await server.close();
  });

  it("includes command-window events in QMP error details", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("stop", (request) => {
        connection.send({ event: "STOP", data: { reason: "request" } });
        connection.send({
          error: { class: "GenericError", desc: "VM is not running" },
          id: request.id,
        });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("stop")).rejects.toMatchObject({
      code: "QMP_COMMAND_FAILED",
      details: {
        qmpClass: "GenericError",
        events: [{ event: "STOP", data: { reason: "request" } }],
      },
    });
    expect(client.drainEvents()).toEqual([]);

    client.close();
    await server.close();
  });

  it("cleans pending state when socket.write throws synchronously", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-status", () => undefined);
    });

    const client = new ThrowingWriteQmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();
    client.failNextWrite = true;

    await expect(client.execute("query-status")).rejects.toMatchObject({
      code: "QMP_DISCONNECTED",
      message: "failed to write QMP command",
      details: { cause: "write failed" },
    });
    expect(() => client.drainEvents()).not.toThrow();

    client.close();
    await server.close();
  });

  it("wraps socket errors as structured Crucible errors", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-status", () => connection.destroyWithError());
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("query-status")).rejects.toMatchObject({
      code: "QMP_DISCONNECTED",
    });

    client.close();
    await server.close();
  });

  it("times out commands without leaking late responses into later commands", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-block", () => undefined);
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("query-block", undefined, { timeoutMs: 20 })).rejects.toMatchObject(
      {
        code: "QMP_TIMEOUT",
        details: { command: "query-block", id: "crucible-2" },
      },
    );

    client.close();
    await server.close();
  });

  it("rejects reused request IDs after a timeout", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-block", () => undefined);
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(
      client.execute("query-block", undefined, { id: "reused", timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "QMP_TIMEOUT" });
    await expect(client.execute("query-status", undefined, { id: "reused" })).rejects.toMatchObject(
      {
        code: "QMP_PROTOCOL_ERROR",
      },
    );

    client.close();
    await server.close();
  });

  it("rejects caller-supplied IDs in the generated request namespace", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(
      client.execute("query-status", undefined, { id: "crucible-2" }),
    ).rejects.toMatchObject({
      code: "QMP_PROTOCOL_ERROR",
      message: "caller-supplied QMP request id uses reserved prefix: crucible-2",
      details: { reservedPrefix: "crucible-" },
    });

    client.close();
    await server.close();
  });

  it("allows many generated IDs without recording them as caller supplied IDs", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-status", (request) => {
        connection.send({ return: { status: "running" }, id: request.id });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("query-status")).resolves.toMatchObject({ id: "crucible-2" });
    await expect(client.execute("query-status")).resolves.toMatchObject({ id: "crucible-3" });
    await expect(client.execute("query-status")).resolves.toMatchObject({ id: "crucible-4" });

    client.close();
    await server.close();
  });

  it("serializes commands and attributes events to the active command", async () => {
    const queryBlockResponses: Array<() => void> = [];
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-block", (request) => {
        queryBlockResponses.push(() => {
          connection.send({ event: "BLOCK_IO_ERROR", data: { device: "disk0" } });
          connection.send({ return: [], id: request.id });
        });
      });
      connection.onCommand("query-status", (request) => {
        connection.send({ event: "STOP", data: { reason: "debug" } });
        connection.send({ return: { status: "paused" }, id: request.id });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    const firstCommand = client.execute("query-block");
    const secondCommand = client.execute("query-status");

    await waitFor(() => queryBlockResponses.length === 1);
    expect(server.requests.map((request) => request.execute)).toEqual([
      "qmp_capabilities",
      "query-block",
    ]);
    queryBlockResponses[0]?.();

    await expect(firstCommand).resolves.toMatchObject({
      events: [{ event: "BLOCK_IO_ERROR", data: { device: "disk0" } }],
    });
    await expect(secondCommand).resolves.toMatchObject({
      events: [{ event: "STOP", data: { reason: "debug" } }],
    });
    expect(server.requests.map((request) => request.execute)).toEqual([
      "qmp_capabilities",
      "query-block",
      "query-status",
    ]);

    client.close();
    await server.close();
  });

  it("fails conservatively on unknown top-level response fields", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-status", (request) => {
        connection.send({ return: {}, id: request.id, extra: true });
      });
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("query-status")).rejects.toMatchObject({ code: "QMP_PARSE_ERROR" });

    client.close();
    await server.close();
  });

  it("preserves parse errors as the terminal failure cause", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-status", () => connection.sendRaw("{\r\n"));
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("query-status")).rejects.toMatchObject({
      code: "QMP_PARSE_ERROR",
      message: "QMP sent invalid JSON",
    });
    await expect(client.execute("query-block")).rejects.toMatchObject({
      code: "QMP_PARSE_ERROR",
      message: "QMP sent invalid JSON",
    });

    client.close();
    await server.close();
  });

  it("preserves protocol errors as the terminal failure cause", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-status", () => connection.send({ return: {}, id: "unknown" }));
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    await expect(client.execute("query-status")).rejects.toMatchObject({
      code: "QMP_PROTOCOL_ERROR",
      message: "QMP response used unknown request id: unknown",
    });
    await expect(client.connect()).rejects.toMatchObject({
      code: "QMP_PROTOCOL_ERROR",
      message: "QMP response used unknown request id: unknown",
    });

    client.close();
    await server.close();
  });

  it("fails fast after the peer closes the socket", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("quit", () => connection.close());
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();
    await expect(client.execute("quit")).rejects.toMatchObject({ code: "QMP_DISCONNECTED" });
    await expect(client.execute("query-status")).rejects.toMatchObject({
      code: "QMP_DISCONNECTED",
    });
    await expect(client.connect()).rejects.toMatchObject({
      code: "QMP_DISCONNECTED",
      message: "QMP socket closed",
    });

    client.close();
    await server.close();
  });

  it("close rejects in-flight commands immediately", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
      connection.onCommand("query-block", () => undefined);
    });

    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 200 });
    await client.connect();

    const command = client.execute("query-block", undefined, { timeoutMs: 500 });
    await waitFor(() => server.requests.some((request) => request.execute === "query-block"));
    client.close();

    await expect(command).rejects.toMatchObject({ code: "QMP_DISCONNECTED" });
    await server.close();
  });

  it("close rejects an in-flight greeting immediately", async () => {
    const server = await createFakeQmpServer(() => undefined);
    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 500 });

    const connect = client.connect();
    await waitFor(() => server.connections.length === 1);
    client.close();

    await expect(connect).rejects.toMatchObject({ code: "QMP_DISCONNECTED" });
    await server.close();
  });

  it("cleans up a missing greeting by closing the socket", async () => {
    const server = await createFakeQmpServer(() => undefined);
    const client = new QmpClient({ socketPath: server.socketPath, timeoutMs: 20 });

    await expect(client.connect()).rejects.toMatchObject({ code: "QMP_TIMEOUT" });
    await expect(client.execute("query-status")).rejects.toMatchObject({
      code: "QMP_DISCONNECTED",
    });

    client.close();
    await server.close();
  });

  it("allows retry after a greeting timeout", async () => {
    const socketPath = path.join(await createTempDir(), "qmp.sock");
    const server = await createFakeQmpServerAt(socketPath, () => undefined);
    const client = new QmpClient({ socketPath, timeoutMs: 20 });

    await expect(client.connect()).rejects.toMatchObject({ code: "QMP_TIMEOUT" });
    await server.close();

    const retryServer = await createFakeQmpServerAt(socketPath, (connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
    });

    await expect(client.connect()).resolves.toEqual(capturedGreeting.QMP);

    client.close();
    await retryServer.close();
  });

  it("recreates the socket after qmp_capabilities times out", async () => {
    const socketPath = path.join(await createTempDir(), "qmp.sock");
    const server = await createFakeQmpServerAt(socketPath, (connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", () => undefined);
    });
    const client = new QmpClient({ socketPath, timeoutMs: 20 });

    await expect(client.connect()).rejects.toMatchObject({
      code: "QMP_TIMEOUT",
      details: { command: "qmp_capabilities" },
    });
    await server.close();

    const retryServer = await createFakeQmpServerAt(socketPath, (connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
    });

    await expect(client.connect()).resolves.toEqual(capturedGreeting.QMP);
    expect(retryServer.requests).toEqual([{ execute: "qmp_capabilities", id: "crucible-2" }]);

    client.close();
    await retryServer.close();
  });

  it("clears partial parser state before retrying on a new socket", async () => {
    const socketPath = path.join(await createTempDir(), "qmp.sock");
    const server = await createFakeQmpServerAt(socketPath, (connection) => {
      connection.sendRaw("partial");
    });
    const client = new QmpClient({ socketPath, timeoutMs: 20 });

    await expect(client.connect()).rejects.toMatchObject({ code: "QMP_TIMEOUT" });
    await server.close();

    const retryServer = await createFakeQmpServerAt(socketPath, (connection) => {
      connection.send(capturedGreeting);
      connection.onCommand("qmp_capabilities", (request) =>
        connection.send({ return: {}, id: request.id }),
      );
    });

    await expect(client.connect()).resolves.toEqual(capturedGreeting.QMP);

    client.close();
    await retryServer.close();
  });

  it("terminates when an unterminated QMP message exceeds the buffer limit", async () => {
    const server = await createFakeQmpServer((connection) => {
      connection.sendRaw("x".repeat(33));
    });
    const client = new QmpClient({
      socketPath: server.socketPath,
      timeoutMs: 200,
      maxBufferBytes: 32,
    });

    await expect(client.connect()).rejects.toMatchObject({
      code: "QMP_PARSE_ERROR",
      message: "QMP message exceeded maximum buffer size",
      details: { maxBufferBytes: 32 },
    });
    await expect(client.connect()).rejects.toMatchObject({
      code: "QMP_PARSE_ERROR",
      message: "QMP message exceeded maximum buffer size",
    });

    client.close();
    await server.close();
  });
});

describe("parseQmpMessage", () => {
  it("parses captured QMP greeting fixtures", () => {
    expect(parseQmpMessage(JSON.stringify(capturedGreeting))).toEqual({
      kind: "greeting",
      greeting: capturedGreeting.QMP,
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseQmpMessage("{")).toThrow(CrucibleError);
  });

  it("rejects unknown greeting fields", () => {
    expect(() =>
      parseQmpMessage(JSON.stringify({ QMP: { ...capturedGreeting.QMP, extra: true } })),
    ).toThrow(/unsupported fields/);
  });
});

type QmpRequest = {
  readonly execute: string;
  readonly arguments?: Record<string, unknown>;
  readonly id?: string | number;
};

type FakeQmpConnection = {
  readonly send: (message: Record<string, unknown>) => void;
  readonly sendMany: (messages: readonly Record<string, unknown>[]) => void;
  readonly sendRaw: (raw: string) => void;
  readonly onCommand: (command: string, handler: (request: QmpRequest) => void) => void;
  readonly close: () => void;
  readonly destroyWithError: () => void;
};

type FakeQmpServer = {
  readonly socketPath: string;
  readonly connections: readonly net.Socket[];
  readonly requests: readonly QmpRequest[];
  readonly close: () => Promise<void>;
};

async function createFakeQmpServer(
  setup: (connection: FakeQmpConnection) => void,
): Promise<FakeQmpServer> {
  const dir = await createTempDir();
  return createFakeQmpServerAt(path.join(dir, "qmp.sock"), setup);
}

async function createFakeQmpServerAt(
  socketPath: string,
  setup: (connection: FakeQmpConnection) => void,
): Promise<FakeQmpServer> {
  const connections: net.Socket[] = [];
  const requests: QmpRequest[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("error", () => undefined);
    const handlers = new Map<string, (request: QmpRequest) => void>();
    const connection: FakeQmpConnection = {
      send: (message) => socket.write(`${JSON.stringify(message)}\r\n`),
      sendMany: (messages) =>
        socket.write(messages.map((message) => JSON.stringify(message)).join("\r\n") + "\r\n"),
      sendRaw: (raw) => socket.write(raw),
      onCommand: (command, handler) => handlers.set(command, handler),
      close: () => socket.end(),
      destroyWithError: () => {
        const error = new Error("fake socket reset") as NodeJS.ErrnoException;
        error.code = "ECONNRESET";
        socket.destroy(error);
      },
    };

    setup(connection);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }

        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }

        const request = JSON.parse(line) as QmpRequest;
        requests.push(request);
        handlers.get(request.execute)?.(request);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath,
    connections,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-qmp-"));
  tempDirs.push(dir);
  return dir;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (predicate()) {
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(intervalMs, remainingMs));
  }
  throw new Error("condition was not met before timeout");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
