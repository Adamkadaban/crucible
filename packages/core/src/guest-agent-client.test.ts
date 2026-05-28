import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GuestAgentClient } from "./guest-agent-client.js";

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
