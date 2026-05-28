// Artifact export. Bundles audit logs, debugger transcripts, dumps,
// scenario results, and SHA-256s into a single tar.gz so the operator
// can hand off a single file for downstream review.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

export type ArtifactDescriptor = {
  readonly path: string;
  readonly label?: string;
};

export type ArtifactExportOptions = {
  readonly outputPath: string;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly manifestPath?: string;
};

export type ArtifactExportResult = {
  readonly outputPath: string;
  readonly manifestPath: string;
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly label?: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }>;
};

/**
 * Compute SHA-256 for every artifact and write a JSON manifest next to
 * the output archive describing each entry. The archive itself is
 * produced by shelling out to `tar` so we get streaming, deterministic
 * compression without taking on another dependency.
 */
export async function exportArtifactBundle(
  options: ArtifactExportOptions,
): Promise<ArtifactExportResult> {
  if (options.artifacts.length === 0) {
    throw new Error("at least one artifact is required for export");
  }
  await mkdir(dirname(options.outputPath), { recursive: true });

  const entries = await Promise.all(
    options.artifacts.map(async (artifact) => {
      const data = await readFile(artifact.path);
      const sha256 = createHash("sha256").update(data).digest("hex");
      return {
        path: artifact.path,
        label: artifact.label,
        sha256,
        sizeBytes: data.byteLength,
      };
    }),
  );

  const manifestPath = options.manifestPath ?? `${options.outputPath}.manifest.json`;
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        outputPath: options.outputPath,
        createdAt: new Date().toISOString(),
        entries,
      },
      null,
      2,
    ),
    "utf8",
  );

  await runTar(
    options.outputPath,
    options.artifacts.map((a) => a.path),
  );

  return { outputPath: options.outputPath, manifestPath, entries };
}

function runTar(outputPath: string, files: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", outputPath, ...files], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}
