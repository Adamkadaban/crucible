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
        "guest-file-open",
        "guest-file-write",
        "guest-file-close",
        "guest-exec",
        "guest-exec-status",
      ]);
      expect(guestExecArgs[0]).toContain("-File");
      const fileArg = (guestExecArgs[0] ?? []).find(
        (entry): entry is string =>
          typeof entry === "string" && entry.endsWith("install-windbg.ps1"),
      );
      expect(fileArg).toBeDefined();
      expect(fileArg).toContain("C:\\ProgramData\\Crucible\\stages\\");
      expect(guestExecArgs[0]).not.toContain("guest/provision/install-windbg.ps1");
      // -NoProfile / -ExecutionPolicy / Bypass / -File should appear exactly
      // once each so we never pass the host-side prefix down as script args.
      for (const flag of ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]) {
        const occurrences = (guestExecArgs[0] ?? []).filter((arg) => arg === flag).length;
        expect(occurrences, `flag ${flag} should appear once`).toBe(1);
      }
      // Trailing script arguments must be preserved.
      expect(guestExecArgs[0]).toContain("-SymbolCache");
      expect(guestExecArgs[0]).toContain("C:\\Symbols");
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
    let activeHandle = 7;
    const fileBuffers: Record<number, { path: string; data: string }> = {};
    const server = await startFakeQga((request) => {
      const args = request.arguments ?? {};
      if (request.execute === "guest-file-open") {
        activeHandle += 1;
        fileBuffers[activeHandle] = { path: args.path as string, data: "" };
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
        return { return: { pid: 99 } };
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
    } finally {
      await server.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

type QgaRequest = {
  readonly execute: string;
  readonly arguments?: Record<string, unknown>;
};

async function startFakeQga(
  handler: (request: QgaRequest) => Promise<Record<string, unknown>> | Record<string, unknown>,
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
  handler: (request: QgaRequest) => Promise<Record<string, unknown>> | Record<string, unknown>,
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
    Promise.resolve(handler(JSON.parse(line) as QgaRequest))
      .then((response) => socket.write(`${JSON.stringify(response)}\r\n`))
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
