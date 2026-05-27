import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ArtifactKind =
  | "disk"
  | "socket"
  | "pidFile"
  | "log"
  | "snapshot"
  | "credential"
  | "media";

export type ArtifactRecord = {
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly sha256?: string;
  readonly metadata?: Record<string, unknown>;
};

export type SnapshotRecord = ArtifactRecord & {
  readonly kind: "snapshot";
  readonly baseDiskPath: string;
  readonly clean: boolean;
};

export type CredentialRecord = ArtifactRecord & {
  readonly kind: "credential";
  readonly principal: string;
  readonly secretPath: string;
};

export type ArtifactManifest = {
  readonly version: 1;
  readonly vmName: string;
  readonly artifacts: readonly ArtifactRecord[];
};

export function createEmptyArtifactManifest(vmName: string): ArtifactManifest {
  return {
    version: 1,
    vmName,
    artifacts: [],
  };
}

export async function readArtifactManifestOrCreate(
  manifestPath: string,
  vmName: string,
): Promise<ArtifactManifest> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as ArtifactManifest;
  } catch (error) {
    if (isMissingPathError(error)) {
      return createEmptyArtifactManifest(vmName);
    }
    throw error;
  }
}

export async function writeArtifactManifest(
  manifestPath: string,
  manifest: ArtifactManifest,
): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeJson(manifestPath, manifest);
}

export function dedupeArtifacts(artifacts: readonly ArtifactRecord[]): readonly ArtifactRecord[] {
  return [
    ...new Map(
      artifacts.map((artifact) => [`${artifact.kind}:${artifact.path}`, artifact]),
    ).values(),
  ];
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
