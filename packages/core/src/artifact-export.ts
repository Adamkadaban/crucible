// Artifact export. Bundles audit logs, debugger transcripts, dumps,
// scenario results, and SHA-256s into a single tar.gz so the operator
// can hand off a single file for downstream review.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
 * Stream-hash every artifact, write a JSON manifest describing each
 * entry, and shell out to `tar -czf` for the archive. Streaming avoids
 * loading multi-GiB dumps / pcaps into memory.
 */
export async function exportArtifactBundle(
  options: ArtifactExportOptions,
): Promise<ArtifactExportResult> {
  if (options.artifacts.length === 0) {
    throw new Error("at least one artifact is required for export");
  }
  const manifestPath = options.manifestPath ?? `${options.outputPath}.manifest.json`;
  await mkdir(dirname(options.outputPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });

  const entries = await Promise.all(
    options.artifacts.map(async (artifact) => {
      const { sha256, sizeBytes } = await streamHash(artifact.path);
      return {
        path: artifact.path,
        label: artifact.label,
        sha256,
        sizeBytes,
      };
    }),
  );

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

async function streamHash(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const stats = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve());
  });
  return { sha256: hash.digest("hex"), sizeBytes: stats.size };
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
