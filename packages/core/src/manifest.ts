export type ArtifactKind =
  | "disk"
  | "socket"
  | "pidFile"
  | "log"
  | "snapshot"
  | "credential"
  | "media"
  | "persona";

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
  readonly qemuTag?: string;
  readonly mode?: "online-qmp" | "offline-qcow2";
  readonly restoredAt?: string;
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

export function upsertArtifactRecord(
  manifest: ArtifactManifest,
  artifact: ArtifactRecord,
): ArtifactManifest {
  const artifacts = manifest.artifacts.filter(
    (existing) => !(existing.kind === artifact.kind && existing.name === artifact.name),
  );

  return {
    ...manifest,
    artifacts: [...artifacts, artifact],
  };
}
