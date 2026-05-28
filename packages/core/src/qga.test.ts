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
      expect(requests).toEqual(["guest-exec", "guest-exec-status"]);
      expect(guestExecArgs[0]).toContain("-EncodedCommand");
      expect(guestExecArgs[0]).not.toContain("guest/provision/install-windbg.ps1");
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
      arguments: ["-NoProfile"],
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
