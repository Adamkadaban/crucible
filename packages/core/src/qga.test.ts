import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { QgaClient, QgaProvisioningExecutor } from "./qga.js";
import type { ProvisioningStageContract } from "./provisioning.js";

describe("QGA client and provisioning executor", () => {
  it("pings QGA", async () => {
    const server = await startFakeQga((request) => {
      expect(request.execute).toBe("guest-ping");
      return { return: {} };
    });
    try {
      await new QgaClient({ socketPath: server.socketPath }).ping();
    } finally {
      await server.close();
    }
  });

  it("runs provisioning scripts through guest-exec", async () => {
    const requests: string[] = [];
    const guestExecArgs: unknown[][] = [];
    const server = await startFakeQga((request) => {
      requests.push(request.execute);
      if (request.execute === "guest-exec") {
        guestExecArgs.push((request.arguments?.arg as unknown[]) ?? []);
        return { return: { pid: 42 } };
      }
      if (request.execute === "guest-exec-status") {
        return { return: { exited: true, exitcode: 0 } };
      }
      return { return: {} };
    });
    try {
      const executor = new QgaProvisioningExecutor({
        client: new QgaClient({ socketPath: server.socketPath }),
        vmName: "analysis-one",
        secretsDirectory: "secrets",
        timeoutMs: 1000,
      });
      const result = await executor.runStage(scriptStage());

      expect(result.status).toBe("succeeded");
      expect(requests).toEqual([
        "guest-exec",
        "guest-exec-status",
        "guest-file-open",
        "guest-file-write",
        "guest-file-close",
        "guest-exec",
        "guest-exec-status",
      ]);
      // First guest-exec is the New-Item -Force for C:\ProgramData\Crucible\stages.
      expect(guestExecArgs[0]?.[0]).toBe("-NoProfile");
      const psCommand = (guestExecArgs[0] ?? []).find(
        (entry): entry is string => typeof entry === "string" && entry.includes("New-Item"),
      );
      expect(psCommand).toBeDefined();
      expect(psCommand as string).toContain("C:\\ProgramData\\Crucible\\stages");
      // Second guest-exec is the real powershell invocation.
      expect(guestExecArgs[1]).toContain("-File");
      const fileArg = (guestExecArgs[1] ?? []).find(
        (entry): entry is string =>
          typeof entry === "string" && entry.endsWith("install-windbg.ps1"),
      );
      expect(fileArg).toBeDefined();
      expect(fileArg).toContain("C:\\ProgramData\\Crucible\\stages\\");
      expect(guestExecArgs[1]).not.toContain("guest/provision/install-windbg.ps1");
      for (const flag of ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]) {
        const occurrences = (guestExecArgs[1] ?? []).filter((arg) => arg === flag).length;
        expect(occurrences, `flag ${flag} should appear once`).toBe(1);
      }
      expect(guestExecArgs[1]).toContain("-SymbolCache");
      expect(guestExecArgs[1]).toContain("C:\\Symbols");
    } finally {
      await server.close();
    }
  });

  it("injects account secrets as guest-exec environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-qga-secrets-"));
    await mkdir(join(root, "analysis-one", "windows"), { recursive: true });
    await writeFile(
      join(root, "analysis-one", "windows", "standard-user.json"),
      JSON.stringify({ username: "CrucibleUser", password: "standard-secret" }),
      "utf8",
    );
    await writeFile(
      join(root, "analysis-one", "windows", "admin-user.json"),
      JSON.stringify({ username: "CrucibleAdmin", password: "admin-secret" }),
      "utf8",
    );
    let env: unknown;
    const server = await startFakeQga((request) => {
      if (request.execute === "guest-exec") {
        env = request.arguments?.env;
        return { return: { pid: 42 } };
      }
      if (request.execute === "guest-exec-status") {
        return { return: { exited: true, exitcode: 0 } };
      }
      return { return: {} };
    });
    try {
      const executor = new QgaProvisioningExecutor({
        client: new QgaClient({ socketPath: server.socketPath }),
        vmName: "analysis-one",
        secretsDirectory: root,
        timeoutMs: 1000,
      });

      await executor.runStage(accountStage());

      expect(env).toEqual([
        "CRUCIBLE_STANDARD_PASSWORD=standard-secret",
        "CRUCIBLE_ADMIN_PASSWORD=admin-secret",
      ]);
    } finally {
      await server.close();
    }
  });

  it("retries guest-ping for the qga-ready stage until the agent answers", async () => {
    let pingCount = 0;
    const server = await startFakeQga((request) => {
      if (request.execute === "guest-ping") {
        pingCount += 1;
        if (pingCount < 3) {
          return { error: { class: "GenericError", desc: "agent not ready" } };
        }
        return { return: {} };
      }
      return { return: {} };
    });
    try {
      const sleeps: number[] = [];
      const executor = new QgaProvisioningExecutor({
        client: new QgaClient({ socketPath: server.socketPath, timeoutMs: 200 }),
        vmName: "analysis-one",
        secretsDirectory: "secrets",
        readinessTimeoutMs: 60_000,
        readinessPollIntervalMs: 25,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      const result = await executor.runStage(qgaReadyStage());

      expect(result.status).toBe("succeeded");
      expect(pingCount).toBeGreaterThanOrEqual(3);
      expect(sleeps.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  it("surfaces a QMP_TIMEOUT when QGA never answers within the readiness window", async () => {
    const server = await startFakeQga(() => ({
      error: { class: "GenericError", desc: "guest unavailable" },
    }));
    try {
      let now = 0;
      const executor = new QgaProvisioningExecutor({
        client: new QgaClient({ socketPath: server.socketPath, timeoutMs: 50 }),
        vmName: "analysis-one",
        secretsDirectory: "secrets",
        readinessTimeoutMs: 200,
        readinessPollIntervalMs: 25,
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      });

      await expect(executor.runStage(qgaReadyStage())).rejects.toMatchObject({
        code: "QMP_TIMEOUT",
      });
    } finally {
      await server.close();
    }
  });

  it("stages registered files via guest-file-open/write/close before the stage script runs", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crucible-stage-"));
    const hostFile = join(tmp, "ca.cert.pem");
    await writeFile(hostFile, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");

    const writes: Array<{ path: string; buf: string }> = [];
    const events: Array<{ kind: string; detail: string }> = [];
    let activeHandle = 7;
    let execPid = 100;
    const fileBuffers: Record<number, { path: string; data: string }> = {};
    const execCommands: Record<number, string> = {};
    const server = await startFakeQga((request) => {
      const args = request.arguments ?? {};
      if (request.execute === "guest-file-open") {
        const p = args.path as string;
        events.push({ kind: "file-open", detail: p });
        activeHandle += 1;
        fileBuffers[activeHandle] = { path: p, data: "" };
        return { return: { handle: activeHandle } };
      }
      if (request.execute === "guest-file-write") {
        const handle = args.handle as number;
        const entry = fileBuffers[handle];
        const chunk = args["buf-b64"];
        if (entry !== undefined && typeof chunk === "string") {
          entry.data += chunk;
        }
        return { return: {} };
      }
      if (request.execute === "guest-file-close") {
        const handle = args.handle as number;
        const entry = fileBuffers[handle];
        if (entry !== undefined) {
          writes.push({ path: entry.path, buf: entry.data });
        }
        return { return: {} };
      }
      if (request.execute === "guest-exec") {
        execPid += 1;
        const argv = (args.arg as readonly string[] | undefined) ?? [];
        const cmd = `${args.path as string} ${argv.join(" ")}`;
        execCommands[execPid] = cmd;
        events.push({ kind: "exec", detail: cmd });
        return { return: { pid: execPid } };
      }
      if (request.execute === "guest-exec-status") {
        return { return: { exited: true, exitcode: 0 } };
      }
      return { return: {} };
    });
    try {
      const executor = new QgaProvisioningExecutor({
        client: new QgaClient({ socketPath: server.socketPath }),
        vmName: "stage-vm",
        secretsDirectory: "secrets",
        filesToStage: {
          "guest-agent-installed": [
            {
              hostPath: hostFile,
              guestPath: "C:\\ProgramData\\Crucible\\Agent\\certs\\ca.cert.pem",
            },
          ],
        },
      });
      const result = await executor.runStage({
        ...scriptStage(),
        id: "guest-agent-installed",
      });
      expect(result.status).toBe("succeeded");
      // 2 writes: our staged ca.cert.pem + the executor's own copy of the
      // PowerShell script. We care that the staged file landed at the
      // configured guest path before the exec happened.
      const stagedWrite = writes.find(
        (w) => w.path === "C:\\ProgramData\\Crucible\\Agent\\certs\\ca.cert.pem",
      );
      expect(stagedWrite).toBeDefined();

      // Regression for #119: New-Item must run for each guestPath's parent
      // BEFORE the corresponding guest-file-open, otherwise qemu-ga errors
      // with `guest-file-open` against a missing dir on first provision.
      function indexOfFirst(matcher: (event: { kind: string; detail: string }) => boolean): number {
        return events.findIndex(matcher);
      }
      const certsMkdir = indexOfFirst(
        (e) =>
          e.kind === "exec" &&
          e.detail.includes("New-Item") &&
          e.detail.includes("C:\\ProgramData\\Crucible\\Agent\\certs"),
      );
      const certsOpen = indexOfFirst(
        (e) =>
          e.kind === "file-open" &&
          e.detail === "C:\\ProgramData\\Crucible\\Agent\\certs\\ca.cert.pem",
      );
      expect(certsMkdir).toBeGreaterThanOrEqual(0);
      expect(certsOpen).toBeGreaterThanOrEqual(0);
      expect(certsMkdir).toBeLessThan(certsOpen);

      const stagesMkdir = indexOfFirst(
        (e) =>
          e.kind === "exec" &&
          e.detail.includes("New-Item") &&
          e.detail.includes("C:\\ProgramData\\Crucible\\stages"),
      );
      const scriptOpen = indexOfFirst(
        (e) => e.kind === "file-open" && e.detail.startsWith("C:\\ProgramData\\Crucible\\stages\\"),
      );
      expect(stagesMkdir).toBeGreaterThanOrEqual(0);
      expect(scriptOpen).toBeGreaterThanOrEqual(0);
      expect(stagesMkdir).toBeLessThan(scriptOpen);
    } finally {
      await server.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("writeFile transparently retries when qga drops the connection mid-write", async () => {
    // First guest-file-open succeeds, then the very next request errors as
    // if qga lost its handle (Windows rebooted), then a fresh open succeeds
    // and the bytes land. The retry layer should hide this from the caller.
    let opens = 0;
    let writeAttempt = 0;
    let lastHandle = 0;
    const finalWrites: Array<{ path: string; bytes: number }> = [];
    const fileBuffers: Record<number, { path: string; data: string }> = {};
    const server = await startFakeQga((request) => {
      const args = request.arguments ?? {};
      if (request.execute === "guest-file-open") {
        opens += 1;
        lastHandle += 1;
        fileBuffers[lastHandle] = { path: args.path as string, data: "" };
        return { return: { handle: lastHandle } };
      }
      if (request.execute === "guest-file-write") {
        writeAttempt += 1;
        if (writeAttempt === 1) {
          // Pretend qga dropped the handle after the agent restarted.
          return { error: { class: "GenericError", desc: "Invalid file handle" } };
        }
        const handle = args.handle as number;
        const entry = fileBuffers[handle];
        if (entry !== undefined && typeof args["buf-b64"] === "string") {
          entry.data += args["buf-b64"];
        }
        return { return: {} };
      }
      if (request.execute === "guest-file-close") {
        const handle = args.handle as number;
        const entry = fileBuffers[handle];
        if (entry !== undefined) {
          finalWrites.push({ path: entry.path, bytes: entry.data.length });
        }
        return { return: {} };
      }
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 5000, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      await client.writeFile("C:\\Test\\file.bin", Buffer.from("hello"));
      expect(opens).toBeGreaterThanOrEqual(2);
      const successful = finalWrites.find((w) => w.bytes > 0);
      expect(successful).toBeDefined();
      expect(successful?.path).toBe("C:\\Test\\file.bin");
    } finally {
      await server.close();
    }
  });

  it("idempotent exec resubmits when qga reports the pid is gone", async () => {
    // First guest-exec returns pid 100. The status poll says pid not found
    // (Windows rebooted, agent forgot). The retry layer must resubmit
    // guest-exec to get a fresh pid, then poll that one normally.
    let execs = 0;
    let statusCalls = 0;
    const pidsIssued: number[] = [];
    const server = await startFakeQga((request) => {
      const args = request.arguments ?? {};
      if (request.execute === "guest-exec") {
        execs += 1;
        const pid = 100 + execs;
        pidsIssued.push(pid);
        return { return: { pid } };
      }
      if (request.execute === "guest-exec-status") {
        statusCalls += 1;
        const pid = args.pid as number;
        // First poll against the original pid: pretend the agent restarted.
        if (statusCalls === 1 && pid === 101) {
          return { error: { class: "GenericError", desc: "pid not found" } };
        }
        return { return: { exited: true, exitcode: 0, "out-data": "" } };
      }
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 5000, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      const result = await client.exec("cmd.exe", ["/c", "echo hi"], { idempotent: true });
      expect(result.exitCode).toBe(0);
      expect(execs).toBe(2);
      expect(pidsIssued).toEqual([101, 102]);
    } finally {
      await server.close();
    }
  });

  it("non-idempotent exec propagates 'pid not found' instead of resubmitting", async () => {
    let execs = 0;
    const server = await startFakeQga((request) => {
      if (request.execute === "guest-exec") {
        execs += 1;
        return { return: { pid: 200 } };
      }
      if (request.execute === "guest-exec-status") {
        return { error: { class: "GenericError", desc: "pid not found" } };
      }
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 1000, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      await expect(client.exec("cmd.exe", ["/c", "echo hi"])).rejects.toThrow(/guest-exec-status/);
      expect(execs).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("retry budget exhaustion surfaces a PROCESS_TIMEOUT naming the operation", async () => {
    const server = await startFakeQga((request) => {
      if (request.execute === "guest-file-open") {
        return { return: { handle: 1 } };
      }
      if (request.execute === "guest-file-write") {
        return { error: { class: "GenericError", desc: "invalid handle" } };
      }
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 50, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      await expect(client.writeFile("C:\\Test\\file.bin", "x")).rejects.toThrow(
        /retry budget exhausted/,
      );
    } finally {
      await server.close();
    }
  });

  it("writeFile retries when the connection drops mid-request (socket error)", async () => {
    // First open succeeds. First write triggers the fake to destroy the
    // socket — that raises a 'QGA socket error' PROCESS_FAILED on the host
    // side, which must be classified transient so the retry loop can
    // re-open + re-write to a healthy fake.
    let dropOnNextWrite = true;
    const successfulWrites: number[] = [];
    let nextHandle = 0;
    const server = await startFakeQga((request, socket) => {
      const args = request.arguments ?? {};
      if (request.execute === "guest-file-open") {
        nextHandle += 1;
        return { return: { handle: nextHandle } };
      }
      if (request.execute === "guest-file-write") {
        if (dropOnNextWrite) {
          dropOnNextWrite = false;
          socket.destroy();
          return undefined;
        }
        successfulWrites.push(args.handle as number);
        return { return: {} };
      }
      if (request.execute === "guest-file-close") {
        return { return: {} };
      }
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 5000, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      await client.writeFile("C:\\Test\\dropped.bin", Buffer.from("payload"));
      expect(nextHandle).toBeGreaterThanOrEqual(2);
      expect(successfulWrites.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("writeFile surfaces the original write error rather than a masking close error", async () => {
    // The first write fails non-transiently. Close also fails (handle is
    // gone). The caller must see the write error, not the close one.
    const server = await startFakeQga((request) => {
      if (request.execute === "guest-file-open") {
        return { return: { handle: 1 } };
      }
      if (request.execute === "guest-file-write") {
        return { error: { class: "GenericError", desc: "disk full" } };
      }
      if (request.execute === "guest-file-close") {
        return { error: { class: "GenericError", desc: "no such handle" } };
      }
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 50, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      await expect(client.writeFile("C:\\Test\\file.bin", "x")).rejects.toThrow(/guest-file-write/);
    } finally {
      await server.close();
    }
  });
});

type QgaRequest = {
  readonly execute: string;
  readonly arguments?: Record<string, unknown>;
};

async function startFakeQga(
  handler: (
    request: QgaRequest,
    socket: Socket,
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined,
): Promise<{ readonly socketPath: string; readonly close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "crucible-qga-"));
  const socketPath = join(root, "qga.sock");
  const server = createServer((socket) => handleSocket(socket, handler));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    socketPath,
    close: () => closeServer(server),
  };
}

function handleSocket(
  socket: Socket,
  handler: (
    request: QgaRequest,
    socket: Socket,
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined,
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      return;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    Promise.resolve(handler(JSON.parse(line) as QgaRequest, socket))
      .then((response) => {
        // A handler that returns undefined has already mutated the socket
        // (e.g. destroyed it) to simulate a transport-level failure.
        if (response === undefined) {
          return;
        }
        socket.write(`${JSON.stringify(response)}\r\n`);
      })
      .catch((error: unknown) => socket.destroy(error instanceof Error ? error : undefined));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function qgaReadyStage(): ProvisioningStageContract {
  return {
    id: "qga-ready",
    title: "QGA readiness",
    dependsOn: ["vm-booted"],
    readinessChecks: [],
    producesSecrets: [],
    producesSnapshot: false,
  };
}

function scriptStage(): ProvisioningStageContract {
  return {
    id: "windbg-installed",
    title: "Install WinDbg",
    dependsOn: ["qga-ready"],
    readinessChecks: [],
    script: {
      id: "install-windbg",
      runner: "qga-powershell",
      executable: "powershell.exe",
      scriptPath: "guest/provision/install-windbg.ps1",
      // Mirror the real provisioning plan: contract args carry the full
      // PowerShell invocation including the prefix and the host-side script
      // path, followed by any user-provided script arguments.
      arguments: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "guest/provision/install-windbg.ps1",
        "-SymbolCache",
        "C:\\Symbols",
      ],
      timeoutMs: 1000,
      elevated: true,
      redactedArgumentIndexes: [],
      environmentSecretRefs: [],
    },
    producesSecrets: [],
    producesSnapshot: false,
  };
}

function accountStage(): ProvisioningStageContract {
  return {
    ...scriptStage(),
    id: "local-accounts-created",
    script: {
      ...scriptStage().script!,
      scriptPath: "guest/provision/create-local-accounts.ps1",
      environmentSecretRefs: ["windows-standard-password", "windows-admin-password"],
    },
  };
}
