import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CrucibleError } from "./errors.js";
import { parseQmpMessage, QmpClient } from "./qmp.js";

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

    client.close();
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
  readonly onCommand: (command: string, handler: (request: QmpRequest) => void) => void;
  readonly close: () => void;
};

type FakeQmpServer = {
  readonly socketPath: string;
  readonly requests: readonly QmpRequest[];
  readonly close: () => Promise<void>;
};

async function createFakeQmpServer(
  setup: (connection: FakeQmpConnection) => void,
): Promise<FakeQmpServer> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-qmp-"));
  tempDirs.push(dir);
  const socketPath = path.join(dir, "qmp.sock");
  const requests: QmpRequest[] = [];
  const server = net.createServer((socket) => {
    const handlers = new Map<string, (request: QmpRequest) => void>();
    const connection: FakeQmpConnection = {
      send: (message) => socket.write(`${JSON.stringify(message)}\r\n`),
      onCommand: (command, handler) => handlers.set(command, handler),
      close: () => socket.end(),
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met before timeout");
}
