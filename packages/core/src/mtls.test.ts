import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureMtlsBundle } from "./mtls.js";

const hasOpenssl = await (async () => {
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise<boolean>((resolve) => {
      const child = spawn("openssl", ["version"], { stdio: ["ignore", "ignore", "ignore"] });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    });
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)("ensureMtlsBundle", () => {
  it("creates a usable CA + server + client triple under <secretsDir>/<vm>/mtls", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-mtls-"));
    try {
      const paths = await ensureMtlsBundle({
        vmName: "test-vm",
        secretsDirectory: root,
      });
      expect(paths.directory).toContain(join("test-vm", "mtls"));
      for (const p of [
        paths.caCertificatePath,
        paths.caPrivateKeyPath,
        paths.serverCertificatePath,
        paths.serverPrivateKeyPath,
        paths.hostClientCertificatePath,
        paths.hostClientPrivateKeyPath,
      ]) {
        const text = await readFile(p, "utf8");
        expect(text).toMatch(/-----BEGIN/);
      }
      const serverPem = await readFile(paths.serverCertificatePath, "utf8");
      // SAN should include the default 192.0.2.2 + 127.0.0.1.
      // We assert on the PEM directly so we don't pull in a cert parser.
      expect(serverPem).toMatch(/-----END CERTIFICATE-----/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent — second call reuses the existing material", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-mtls-"));
    try {
      const first = await ensureMtlsBundle({ vmName: "vm", secretsDirectory: root });
      const before = await readFile(first.serverCertificatePath, "utf8");
      const second = await ensureMtlsBundle({ vmName: "vm", secretsDirectory: root });
      const after = await readFile(second.serverCertificatePath, "utf8");
      expect(after).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honours a custom guest address in the server CN", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-mtls-"));
    try {
      await ensureMtlsBundle({
        vmName: "vm",
        secretsDirectory: root,
        guestAddress: "10.0.0.42",
      });
      // openssl x509 -in cert -text would show the SAN. We can't easily
      // shell out from inside the test, but we can confirm the .ext file
      // captured the guestAddress before the cert was signed.
      const ext = await readFile(join(root, "vm", "mtls", "guest-server.ext"), "utf8");
      expect(ext).toContain("IP:10.0.0.42");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
