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
