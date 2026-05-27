import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseCrucibleConfig } from "./config.js";
import { SnapshotManager } from "./snapshot.js";

describe("snapshot manager", () => {
  it("creates qcow2 internal snapshot metadata through QMP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "crucible-snapshot-"));
    const commands: string[] = [];
    const config = parseCrucibleConfig({
      vm: { name: "test-win" },
      artifacts: {
        directory: path.join(root, "artifacts"),
        manifestPath: path.join(root, "artifacts", "manifest.json"),
        logsDirectory: path.join(root, "artifacts", "logs"),
        snapshotsDirectory: path.join(root, "snapshots"),
        secretsDirectory: path.join(root, "secrets"),
      },
      qmp: { socketPath: path.join(root, "artifacts", "qmp.sock") },
      qga: { socketPath: path.join(root, "artifacts", "qga.sock") },
    });
    const manager = new SnapshotManager({
      config,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      qmpClientFactory: () => fakeQmpSession(commands),
    });

    const result = await manager.create("clean-base");

    expect(commands).toEqual(["savevm clean-base"]);
    expect(result).toMatchObject({
      operation: "create",
      snapshotName: "clean-base",
      qmpCommand: "savevm",
      clean: true,
    });
    expect(JSON.parse(await readFile(result.metadataPath, "utf8"))).toMatchObject({
      operation: "create",
      snapshotName: "clean-base",
      clean: true,
    });
    expect(JSON.parse(await readFile(config.artifacts.manifestPath, "utf8"))).toMatchObject({
      artifacts: [expect.objectContaining({ kind: "snapshot", name: "clean-base", clean: true })],
    });
  });

  it("restores snapshots through QMP loadvm", async () => {
    const commands: string[] = [];
    const manager = new SnapshotManager({ qmpClientFactory: () => fakeQmpSession(commands) });

    const result = await manager.restore("clean-base");

    expect(commands).toEqual(["loadvm clean-base"]);
    expect(result.operation).toBe("restore");
  });

  it("rejects unsafe snapshot names", async () => {
    const manager = new SnapshotManager({ qmpClientFactory: () => fakeQmpSession([]) });

    await expect(manager.create("../clean-base")).rejects.toThrow(/Snapshot names/);
  });
});

function fakeQmpSession(commands: string[]) {
  return {
    connect: () => Promise.resolve({}),
    execute: <T>(command: string, args?: Readonly<Record<string, unknown>>) => {
      expect(command).toBe("human-monitor-command");
      commands.push(String(args?.["command-line"]));
      return Promise.resolve({ returnValue: {} as T });
    },
    close: () => undefined,
  };
}
