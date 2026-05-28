// Credential rotation. Replaces the per-VM windows account secrets and
// (optionally) re-issues the mTLS certificate material that the guest
// service serves. Both operations write only into artifacts/secrets/<vm>/
// and never broadcast the secret values.

import { randomBytes } from "node:crypto";

import {
  buildProvisioningSecretStorageContract,
  writeWindowsAccountSecrets,
  type WindowsAccountSecretSummary,
} from "./provisioning.js";

export type RotateCredentialsOptions = {
  readonly vmName: string;
  readonly secretsDirectory: string;
  readonly standardUsername?: string;
  readonly adminUsername?: string;
  readonly randomBytes?: (size: number) => Buffer;
};

export type RotateCredentialsResult = {
  readonly rootDirectory: string;
  readonly accounts: readonly WindowsAccountSecretSummary[];
};

/**
 * Generate fresh local-account passwords and persist them under
 * artifacts/secrets/<vm>/windows. The next `crucible provision` (or any
 * guest-side stage that consumes the secret) will pick up the new values.
 */
export async function rotateLocalAccountCredentials(
  options: RotateCredentialsOptions,
): Promise<RotateCredentialsResult> {
  return writeWindowsAccountSecrets({
    vmName: options.vmName,
    secretsDirectory: options.secretsDirectory,
    standardUsername: options.standardUsername,
    adminUsername: options.adminUsername,
    randomBytes: options.randomBytes ?? randomBytes,
  });
}

/**
 * Return the deterministic disk locations of the mTLS material so the
 * caller can shell out to openssl (or any other tool) when re-issuing
 * certificates. Crucible does not currently mint certificates itself.
 */
export function rotateGuestServiceCertificatesPlan(
  vmName: string,
  secretsDirectory: string,
): {
  readonly caCertificatePath: string;
  readonly guestServerCertificatePath: string;
  readonly guestServerPrivateKeyPath: string;
} {
  const contract = buildProvisioningSecretStorageContract(vmName, secretsDirectory);
  const find = (kind: string) => {
    const ref = contract.secretRefs.find((entry) => entry.kind === kind);
    if (ref === undefined) {
      throw new Error(`missing provisioning secret reference for ${kind}`);
    }
    return ref.path;
  };
  return {
    caCertificatePath: find("mtls-ca-certificate"),
    guestServerCertificatePath: find("mtls-guest-server-certificate"),
    guestServerPrivateKeyPath: find("mtls-guest-server-private-key"),
  };
}
