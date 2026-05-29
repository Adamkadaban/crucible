import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
      // The stage script ships on crucible-payload.iso (CD-ROM, volume
      // label CRUCIBLE) so the executor only needs ONE guest-exec /
      // guest-exec-status pair — no upload via writeFile / file-open /
      // file-write / file-close. The exec args are a powershell
      // -Command that looks up the CD by label and invokes the script
      // from there.
      expect(requests).toEqual(["guest-exec", "guest-exec-status"]);
      expect(guestExecArgs[0]?.[0]).toBe("-NoProfile");
      expect(guestExecArgs[0]).toContain("-Command");
      const psBlock = (guestExecArgs[0] ?? []).find(
        (entry): entry is string =>
          typeof entry === "string" && entry.includes("Win32_LogicalDisk"),
      );
      expect(psBlock).toBeDefined();
      // The PowerShell block discovers the CRUCIBLE CD by volume label
      // and executes the named script from there.
      expect(psBlock as string).toContain("VolumeName -eq 'CRUCIBLE'");
      expect(psBlock as string).toContain("install-windbg.ps1");
      // User-supplied script arguments are embedded INSIDE the PowerShell
      // -Command block as a $argv array literal (NOT trailing argv to
      // powershell.exe — -Command swallows everything after the script
      // as part of the command source, which would be a parse error).
      expect(psBlock as string).toContain("'-SymbolCache'");
      expect(psBlock as string).toContain("'C:\\Symbols'");
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

  it("aborts in-flight retry sleep when the AbortSignal fires (no 5min hang on dead VM)", async () => {
    // Simulates a dead VM by destroying every connection. connectSocket
    // sees the FIN, throws PROCESS_FAILED "QGA socket error" which is
    // classified transient, retry loop sleeps. Without an abort the loop
    // would burn the full 5 min budget. With one, the in-flight sleep
    // wakes up immediately and rejects.
    const server = await startFakeQga((_request, socket) => {
      socket.destroy();
      return undefined;
    });
    try {
      const controller = new AbortController();
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 5 * 60 * 1000, initialBackoffMs: 50, maxBackoffMs: 50 },
        signal: controller.signal,
      });
      const pending = client.writeFile("C:\\Test\\file.bin", "x");
      setTimeout(() => controller.abort(new Error("QEMU died")), 30);
      const started = Date.now();
      await expect(pending).rejects.toThrow(/aborted/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await server.close();
    }
  });

  it("rejects immediately when the AbortSignal is already aborted at call time", async () => {
    const server = await startFakeQga(() => ({ return: {} }));
    try {
      const controller = new AbortController();
      controller.abort(new Error("already gone"));
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 60_000, initialBackoffMs: 50, maxBackoffMs: 100 },
        signal: controller.signal,
      });
      await expect(client.writeFile("C:\\Test\\file.bin", "x")).rejects.toThrow(/already gone/);
    } finally {
      await server.close();
    }
  });

  it("retries guest-file-open through Defender ERROR_SHARING_VIOLATION", async () => {
    // Regression for #130 root cause: Windows Defender's on-access scanner
    // briefly opens newly-created .ps1 files with FILE_SHARE_READ only,
    // racing qemu-ga's GENERIC_WRITE open. qemu-ga surfaces the localized
    // OS message ("The process cannot access the file because it is being
    // used by another process."). Without classifying that as transient,
    // writeFile fails on the very first stage that uploads a script and
    // provisioning never reaches qga-ready's actual work.
    let openAttempts = 0;
    const server = await startFakeQga((request) => {
      const args = request.arguments ?? {};
      if (request.execute === "guest-file-open") {
        openAttempts += 1;
        if (openAttempts === 1) {
          return {
            error: {
              class: "GenericError",
              desc: `failed to open file '${args.path as string}': The process cannot access the file because it is being used by another process.`,
            },
          };
        }
        return { return: { handle: 42 } };
      }
      if (request.execute === "guest-file-write") return { return: {} };
      if (request.execute === "guest-file-close") return { return: {} };
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 5_000, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      await client.writeFile("C:\\Test\\probe.ps1", "Write-Host hi");
      expect(openAttempts).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  it("writeFile runs guest-file-{open,write,close} on a single connection (qemu-ga handle-leak fix)", async () => {
    // Regression for the second half of #130: qemu-ga on Windows
    // (qga/commands-win32.c) has a process-global file-handle table
    // with NO per-client cleanup on disconnect. Issuing open and close
    // on separate sockets leaks the handle forever in qga.exe and
    // every subsequent open for the same path fails
    // ERROR_SHARING_VIOLATION against qemu-ga's own orphaned handle.
    // The whole open/write/close MUST run on one socket.
    const connectionsByCommand = new Map<string, number>();
    const socketSeen = new Map<Socket, number>();
    let socketCounter = 0;
    const server = await startFakeQga((request, socket) => {
      let id = socketSeen.get(socket);
      if (id === undefined) {
        socketCounter += 1;
        id = socketCounter;
        socketSeen.set(socket, id);
      }
      const command = request.execute;
      connectionsByCommand.set(command, (connectionsByCommand.get(command) ?? 0) + id);
      if (command === "guest-file-open") return { return: { handle: 42 } };
      if (command === "guest-file-write") return { return: {} };
      if (command === "guest-file-close") return { return: {} };
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 1000, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      await client.writeFile("C:\\Test\\a.bin", Buffer.from("payload"));
      // Exactly ONE socket should have served open + write + close.
      expect(socketCounter).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("propagates non-sharing-violation guest-file-open errors without retrying", async () => {
    let openAttempts = 0;
    const server = await startFakeQga((request) => {
      if (request.execute === "guest-file-open") {
        openAttempts += 1;
        return {
          error: { class: "GenericError", desc: "Access is denied." },
        };
      }
      return { return: {} };
    });
    try {
      const client = new QgaClient({
        socketPath: server.socketPath,
        timeoutMs: 1000,
        retryPolicy: { budgetMs: 5_000, initialBackoffMs: 1, maxBackoffMs: 5 },
        sleep: () => Promise.resolve(),
      });
      await expect(client.writeFile("C:\\Test\\x.bin", "x")).rejects.toThrow(/Access is denied/);
      expect(openAttempts).toBe(1);
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
