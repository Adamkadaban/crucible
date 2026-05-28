// Per-VM mTLS material generation for the Crucible guest agent. We shell
// out to openssl rather than synthesise X.509 in JS because the agent /
// host integration already assumes PEM bundles on disk, and the operator
// frequently wants to inspect them with the same tools.

import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export type MtlsBundlePaths = {
  readonly directory: string;
  readonly caCertificatePath: string;
  readonly caPrivateKeyPath: string;
  readonly serverCertificatePath: string;
  readonly serverPrivateKeyPath: string;
  readonly hostClientCertificatePath: string;
  readonly hostClientPrivateKeyPath: string;
};

export type EnsureMtlsBundleOptions = {
  readonly vmName: string;
  readonly secretsDirectory: string;
  /** SAN/CN for the agent's server certificate. Defaults to 192.0.2.2. */
  readonly guestAddress?: string;
  /** Validity period in days. Defaults to 365. */
  readonly validityDays?: number;
  /** Override openssl binary; useful for tests. */
  readonly opensslExecutable?: string;
};

/**
 * Generate (or reuse, if already present) a per-VM mTLS PKI under
 * `<secretsDirectory>/<vmName>/mtls/`. Output:
 *
 * - `ca.cert.pem` / `ca.key.pem` — self-signed CA, the trust root.
 * - `guest-server.cert.pem` / `guest-server.key.pem` — agent's TLS server
 *   cert, signed by the CA, SAN = `<guestAddress>` + `127.0.0.1` + DNS:
 *   `localhost`.
 * - `host-client.cert.pem` / `host-client.key.pem` — host's TLS client
 *   cert, signed by the CA, extendedKeyUsage = clientAuth.
 *
 * Existing material is reused so repeated provisions don't rotate the
 * certs the operator already pinned in their MCP client config.
 */
export async function ensureMtlsBundle(options: EnsureMtlsBundleOptions): Promise<MtlsBundlePaths> {
  const directory = path.join(options.secretsDirectory, options.vmName, "mtls");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const paths: MtlsBundlePaths = {
    directory,
    caCertificatePath: path.join(directory, "ca.cert.pem"),
    caPrivateKeyPath: path.join(directory, "ca.key.pem"),
    serverCertificatePath: path.join(directory, "guest-server.cert.pem"),
    serverPrivateKeyPath: path.join(directory, "guest-server.key.pem"),
    hostClientCertificatePath: path.join(directory, "host-client.cert.pem"),
    hostClientPrivateKeyPath: path.join(directory, "host-client.key.pem"),
  };

  const openssl = options.opensslExecutable ?? "openssl";
  const guestAddress = options.guestAddress ?? "192.0.2.2";
  const days = String(options.validityDays ?? 365);

  // CA
  if (!(await pathExists(paths.caCertificatePath))) {
    await runOpenssl(openssl, [
      "genpkey",
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-out",
      paths.caPrivateKeyPath,
    ]);
    await runOpenssl(openssl, [
      "req",
      "-new",
      "-x509",
      "-days",
      days,
      "-subj",
      `/CN=crucible-${options.vmName}-ca`,
      "-key",
      paths.caPrivateKeyPath,
      "-out",
      paths.caCertificatePath,
    ]);
  }

  // Server cert
  if (!(await pathExists(paths.serverCertificatePath))) {
    const csrPath = path.join(directory, "guest-server.csr");
    const extPath = path.join(directory, "guest-server.ext");
    await runOpenssl(openssl, [
      "genpkey",
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-out",
      paths.serverPrivateKeyPath,
    ]);
    await runOpenssl(openssl, [
      "req",
      "-new",
      "-subj",
      `/CN=${guestAddress}`,
      "-key",
      paths.serverPrivateKeyPath,
      "-out",
      csrPath,
    ]);
    await writeFile(
      extPath,
      `subjectAltName=DNS:localhost,IP:${guestAddress},IP:127.0.0.1\nextendedKeyUsage=serverAuth\n`,
      "utf8",
    );
    await runOpenssl(openssl, [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      paths.caCertificatePath,
      "-CAkey",
      paths.caPrivateKeyPath,
      "-CAcreateserial",
      "-days",
      days,
      "-extfile",
      extPath,
      "-out",
      paths.serverCertificatePath,
    ]);
  }

  // Host client cert
  if (!(await pathExists(paths.hostClientCertificatePath))) {
    const csrPath = path.join(directory, "host-client.csr");
    const extPath = path.join(directory, "host-client.ext");
    await runOpenssl(openssl, [
      "genpkey",
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-out",
      paths.hostClientPrivateKeyPath,
    ]);
    await runOpenssl(openssl, [
      "req",
      "-new",
      "-subj",
      "/CN=crucible-host-client",
      "-key",
      paths.hostClientPrivateKeyPath,
      "-out",
      csrPath,
    ]);
    await writeFile(extPath, "extendedKeyUsage=clientAuth\n", "utf8");
    await runOpenssl(openssl, [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      paths.caCertificatePath,
      "-CAkey",
      paths.caPrivateKeyPath,
      "-CAcreateserial",
      "-days",
      days,
      "-extfile",
      extPath,
      "-out",
      paths.hostClientCertificatePath,
    ]);
  }

  return paths;
}

function runOpenssl(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`openssl ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
