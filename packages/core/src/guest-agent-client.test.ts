import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GuestAgentClient, fileSize } from "./guest-agent-client.js";

// These tests build the Go guest agent once and run it locally over a fresh
// mTLS test PKI so we can verify the host TS client against the real wire
// protocol without needing a Windows VM.
type TestServer = {
  baseUrl: string;
  caPem: string;
  clientCertPem: string;
  clientKeyPem: string;
  process: ChildProcess;
  workDir: string;
};

let server: TestServer | undefined;

beforeAll(async () => {
  const goAvailable = await hasGo();
  if (!goAvailable) return;
  const workDir = await mkdtemp(join(tmpdir(), "crucible-agent-it-"));
  const stagingDir = join(workDir, "staging");
  const binary = join(workDir, "crucible-guest-agent");
  await runProcess("go", ["build", "-o", binary, "./cmd/crucible-guest-agent"], "guest-agent");

  const { ca, server: serverPair, client } = await generatePki();
  const caPath = join(workDir, "ca.pem");
  const serverCertPath = join(workDir, "server.crt");
  const serverKeyPath = join(workDir, "server.key");
  await writeFile(caPath, ca.cert);
  await writeFile(serverCertPath, serverPair.cert);
  await writeFile(serverKeyPath, serverPair.key);

  const port = await pickPort();
  const listen = `127.0.0.1:${port}`;
  const child = spawn(
    binary,
    [
      "run",
      "--listen",
      listen,
      "--tls-cert",
      serverCertPath,
      "--tls-key",
      serverKeyPath,
      "--tls-client-ca",
      caPath,
      "--staging-dir",
      stagingDir,
      "--max-request-bytes",
      String(8 * 1024 * 1024),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  await waitFor(async () => {
    const net = await import("node:net");
    return new Promise<boolean>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
  });

  server = {
    baseUrl: `https://${listen}`,
    caPem: ca.cert,
    clientCertPem: client.cert,
    clientKeyPem: client.key,
    process: child,
    workDir,
  };
}, 60_000);

afterAll(async () => {
  if (!server) return;
  server.process.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    server!.process.once("exit", () => resolve());
  });
  await rm(server.workDir, { recursive: true, force: true });
}, 30_000);

describe.runIf(!process.env.SKIP_GUEST_AGENT_IT)("GuestAgentClient (integration)", () => {
  it("performs /health, /upload, /download, /exec round-trips", async () => {
    if (server === undefined) {
      // Go toolchain unavailable in this environment; skip.
      return;
    }
    const client = new GuestAgentClient({
      baseUrl: server.baseUrl,
      caPem: server.caPem,
      clientCertificatePem: server.clientCertPem,
      clientPrivateKeyPem: server.clientKeyPem,
      timeoutMs: 10_000,
    });

    const health = await client.health();
    expect(health.status).toBe("ok");

    const payload = Buffer.from("hello crucible");
    const uploaded = await client.upload("samples/hello.bin", payload);
    expect(uploaded.sizeBytes).toBe(payload.byteLength);
    expect(uploaded.sha256).toMatch(/^[0-9a-f]{64}$/);

    const downloaded = await client.download("samples/hello.bin");
    expect(downloaded.equals(payload)).toBe(true);

    const hostUploadPath = join(server.workDir, "host-upload.bin");
    const hostDownloadPath = join(server.workDir, "host-download.bin");
    await writeFile(hostUploadPath, payload);
    const uploadedFile = await client.uploadFile(
      hostUploadPath,
      join(server.workDir, "absolute.bin"),
    );
    expect(uploadedFile.sizeBytes).toBe(payload.byteLength);
    const inspection = await client.inspect(join(server.workDir, "absolute.bin"));
    expect(inspection.headerAscii).toBe("hello crucible");
    const downloadedFile = await client.downloadFile(
      join(server.workDir, "absolute.bin"),
      hostDownloadPath,
    );
    expect(downloadedFile.sizeBytes).toBe(payload.byteLength);
    await expect(readFile(hostDownloadPath)).resolves.toEqual(payload);

    if (process.platform !== "win32") {
      const execResult = await client.exec({
        executable: "/bin/sh",
        arguments: ["-c", "echo crucible"],
        timeoutMs: 2000,
      });
      expect(execResult.exitCode).toBe(0);
      const stdout = Buffer.from(execResult.stdoutBase64 ?? "", "base64").toString();
      expect(stdout.trim()).toBe("crucible");
    }
  });
});

async function hasGo(): Promise<boolean> {
  try {
    await runProcess("go", ["version"], ".");
    return true;
  } catch {
    return false;
  }
}

async function pickPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.unref();
    sock.on("error", reject);
    sock.listen(0, "127.0.0.1", () => {
      const { port } = sock.address() as { port: number };
      sock.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(probe: () => Promise<T>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return;
    await wait(100);
  }
  throw new Error("waitFor timed out");
}

async function runProcess(executable: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

type PkiBundle = { cert: string; key: string };
async function generatePki(): Promise<{
  ca: PkiBundle;
  server: PkiBundle;
  client: PkiBundle;
}> {
  // Self-contained, throwaway PKI. We shell out to openssl so the test has
  // no extra Node-side dependency and the resulting PEM matches what
  // production hosts deploy.
  const tmp = await mkdtemp(join(tmpdir(), "crucible-pki-"));
  try {
    // CA
    await runProcess(
      "openssl",
      ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", "ca.key"],
      tmp,
    );
    await runProcess(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-days",
        "1",
        "-subj",
        "/CN=crucible-test-ca",
        "-key",
        "ca.key",
        "-out",
        "ca.crt",
      ],
      tmp,
    );

    for (const name of ["server", "client"] as const) {
      await runProcess(
        "openssl",
        [
          "genpkey",
          "-algorithm",
          "EC",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-out",
          `${name}.key`,
        ],
        tmp,
      );
      await runProcess(
        "openssl",
        ["req", "-new", "-subj", `/CN=${name}`, "-key", `${name}.key`, "-out", `${name}.csr`],
        tmp,
      );
      const extPath = join(tmp, `${name}.ext`);
      await writeFile(
        extPath,
        name === "server"
          ? "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
          : "extendedKeyUsage=clientAuth\n",
      );
      await runProcess(
        "openssl",
        [
          "x509",
          "-req",
          "-in",
          `${name}.csr`,
          "-CA",
          "ca.crt",
          "-CAkey",
          "ca.key",
          "-CAcreateserial",
          "-days",
          "1",
          "-extfile",
          extPath,
          "-out",
          `${name}.crt`,
        ],
        tmp,
      );
    }
    const read = async (file: string) => (await readFile(join(tmp, file), "utf8")).trim() + "\n";
    return {
      ca: { cert: await read("ca.crt"), key: await read("ca.key") },
      server: { cert: await read("server.crt"), key: await read("server.key") },
      client: { cert: await read("client.crt"), key: await read("client.key") },
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Unit tests using a local Node.js HTTPS server (no Go dependency)
// ---------------------------------------------------------------------------
describe("GuestAgentClient (unit)", () => {
  let httpsServer: HttpsServer;
  let client: GuestAgentClient;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    const pki = await generatePki();
    tmpDir = await mkdtemp(join(tmpdir(), "crucible-unit-"));

    httpsServer = createHttpsServer(
      {
        cert: pki.server.cert,
        key: pki.server.key,
        ca: pki.ca.cert,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        const url = new URL(req.url ?? "/", `https://localhost`);

        if (req.method === "GET" && url.pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              version: "test",
              hostName: "unit",
              startedAt: "2024-01-01T00:00:00Z",
              uptimeSeconds: 42,
              goVersion: "test",
              windbgInstalled: false,
            }),
          );
          return;
        }

        if (req.method === "POST" && url.pathname === "/exec") {
          let body = "";
          req.on("data", (c: Buffer) => (body += c.toString()));
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                exitCode: 0,
                timedOut: false,
                durationMs: 10,
                truncated: false,
                stdoutBase64: Buffer.from("hello\n").toString("base64"),
              }),
            );
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/debug/open") {
          let body = "";
          req.on("data", (c: Buffer) => (body += c.toString()));
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: "sess-1",
                pid: 1234,
                logPath: "C:\\log.txt",
                startedAt: "2024-01-01T00:00:00Z",
              }),
            );
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/debug/command") {
          let body = "";
          req.on("data", (c: Buffer) => (body += c.toString()));
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: "sess-1",
                truncated: false,
                logPath: "C:\\log.txt",
                exited: false,
                outputBase64: Buffer.from("output").toString("base64"),
              }),
            );
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/debug/close") {
          let body = "";
          req.on("data", (c: Buffer) => (body += c.toString()));
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id: "sess-1", closed: true, logPath: "C:\\log.txt" }));
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/upload") {
          // Consume the gzipped body, return a fake result
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                path: url.searchParams.get("path") ?? "",
                sizeBytes: 14,
                sha256: "abcd".repeat(16),
              }),
            );
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/download") {
          const p = url.searchParams.get("path") ?? "";
          if (p === "large") {
            // Return a body that is large (for maxBodyBytes test)
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "x-crucible-size": "999999",
              "x-crucible-sha256": "ff".repeat(32),
            });
            res.end(Buffer.alloc(256, 0x41));
            return;
          }
          const content = Buffer.from("downloaded-data");
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "x-crucible-size": String(content.byteLength),
            "x-crucible-sha256": "cc".repeat(32),
          });
          res.end(content);
          return;
        }

        if (req.method === "GET" && url.pathname === "/inspect") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              path: url.searchParams.get("path") ?? "",
              sizeBytes: 100,
              headerHex: "68656c6c6f",
              headerAscii: "hello",
            }),
          );
          return;
        }

        if (req.method === "GET" && url.pathname === "/error") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("internal server error");
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      },
    );

    const port = await pickPort();
    await new Promise<void>((resolve) => {
      httpsServer.listen(port, "127.0.0.1", () => resolve());
    });
    baseUrl = `https://127.0.0.1:${port}`;

    client = new GuestAgentClient({
      baseUrl,
      caPem: pki.ca.cert,
      clientCertificatePem: pki.client.cert,
      clientPrivateKeyPem: pki.client.key,
      timeoutMs: 5_000,
    });
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((resolve) => {
      if (httpsServer) httpsServer.close(() => resolve());
      else resolve();
    });
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("health() returns parsed JSON", async () => {
    const h = await client.health();
    expect(h.status).toBe("ok");
    expect(h.version).toBe("test");
    expect(h.uptimeSeconds).toBe(42);
  });

  it("exec() posts and returns result", async () => {
    const r = await client.exec({ executable: "/bin/sh", arguments: ["-c", "echo hello"] });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(Buffer.from(r.stdoutBase64 ?? "", "base64").toString()).toBe("hello\n");
  });

  it("debugOpen() returns session info", async () => {
    const r = await client.debugOpen({ executable: "cdb.exe" });
    expect(r.id).toBe("sess-1");
    expect(r.pid).toBe(1234);
  });

  it("debugCommand() returns output", async () => {
    const r = await client.debugCommand("sess-1", "g", 1000);
    expect(r.id).toBe("sess-1");
    expect(r.exited).toBe(false);
  });

  it("debugClose() returns closed status", async () => {
    const r = await client.debugClose("sess-1");
    expect(r.closed).toBe(true);
  });

  it("upload() sends buffer and returns result", async () => {
    const r = await client.upload("test/file.bin", Buffer.from("hello crucible"));
    expect(r.path).toBe("test/file.bin");
    expect(r.sizeBytes).toBe(14);
  });

  it("uploadFile() sends file contents", async () => {
    const filePath = join(tmpDir, "upload-src.bin");
    await writeFile(filePath, "file-content");
    const r = await client.uploadFile(filePath, "remote/path.bin");
    expect(r.path).toBe("remote/path.bin");
  });

  it("download() returns buffer", async () => {
    const buf = await client.download("some/file.bin");
    expect(buf.toString()).toBe("downloaded-data");
  });

  it("download() exceeds maxBodyBytes with same PKI", async () => {
    // Reconstruct the HTTPS server's PKI for a new client with tiny limit
    // The existing client works, so we know the PKI is valid. We access the
    // constructor options via a helper.
    // Actually, we stored pki in beforeAll but it's scoped. Let's generate a
    // fresh PKI and server, or simpler: just test via the "large" path with
    // the existing client that has default 64MB limit - won't trigger.
    // The cleanest approach: create a subclass that exposes maxBodyBytes
    // or re-generate pki.
    // For now, let's just test the error by calling the /download?path=large
    // endpoint which returns 256 bytes, with a client that has maxBodyBytes=10.
    // We need the same PKI... Let's regenerate.
    const pki = await generatePki();
    const port = await pickPort();
    const srv = createHttpsServer(
      {
        cert: pki.server.cert,
        key: pki.server.key,
        ca: pki.ca.cert,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.alloc(256, 0x41));
      },
    );
    await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
    const tinyClient = new GuestAgentClient({
      baseUrl: `https://127.0.0.1:${port}`,
      caPem: pki.ca.cert,
      clientCertificatePem: pki.client.cert,
      clientPrivateKeyPem: pki.client.key,
      maxBodyBytes: 10,
      timeoutMs: 5_000,
    });
    await expect(tinyClient.download("any")).rejects.toThrow(/maxBodyBytes/);
    await tinyClient.close();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }, 30_000);

  it("downloadFile() writes to disk and returns metadata", async () => {
    const dest = join(tmpDir, "dl-output.bin");
    const r = await client.downloadFile("some/file.bin", dest);
    expect(r.path).toBe("some/file.bin");
    expect(r.sizeBytes).toBe(15); // "downloaded-data".length
    const content = await readFile(dest);
    expect(content.toString()).toBe("downloaded-data");
  });

  it("inspect() returns file metadata", async () => {
    const r = await client.inspect("some/file.bin");
    expect(r.headerAscii).toBe("hello");
    expect(r.sizeBytes).toBe(100);
  });

  it("close() resolves without error", async () => {
    // Create a throwaway client just to test close
    const pki = await generatePki();
    const c = new GuestAgentClient({
      baseUrl: "https://127.0.0.1:1",
      caPem: pki.ca.cert,
      clientCertificatePem: pki.client.cert,
      clientPrivateKeyPem: pki.client.key,
    });
    await expect(c.close()).resolves.toBeUndefined();
  });

  it("#request throws on non-ok response", async () => {
    // Hit a 404 endpoint
    await expect(client.download("__nonexistent__")).resolves.toBeDefined();
    // Actually the server returns 200 for any /download path. Use a
    // separate approach: hit an unknown endpoint via health-like call.
    // The simplest: create a client that targets /error.
    // We can't call #request directly, but we can trigger it via inspect
    // on a server that returns 500. Let's use a dedicated server.
    const pki = await generatePki();
    const port = await pickPort();
    const srv = createHttpsServer(
      {
        cert: pki.server.cert,
        key: pki.server.key,
        ca: pki.ca.cert,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("something went wrong");
      },
    );
    await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
    const errClient = new GuestAgentClient({
      baseUrl: `https://127.0.0.1:${port}`,
      caPem: pki.ca.cert,
      clientCertificatePem: pki.client.cert,
      clientPrivateKeyPem: pki.client.key,
      timeoutMs: 5_000,
    });
    await expect(errClient.health()).rejects.toThrow(/500/);
    await errClient.close();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }, 30_000);

  it("fileSize() returns file size", async () => {
    const p = join(tmpDir, "sized.txt");
    await writeFile(p, "abcdef");
    const sz = await fileSize(p);
    expect(sz).toBe(6);
  });
});
