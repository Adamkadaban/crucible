import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  aggregateAuditEvents,
  DEFAULT_POLICY,
  decideDownloadTarget,
  decideHostShare,
  decideInternetEgress,
  exportArtifactBundle,
  rotateGuestServiceCertificatesPlan,
  rotateLocalAccountCredentials,
  runScenario,
} from "./index.js";

describe("policy", () => {
  it("denies host-share by default and accepts paths under allowlists", () => {
    const denied = decideHostShare(DEFAULT_POLICY, "/tmp/payload");
    expect(denied.allowed).toBe(false);

    const policy = { ...DEFAULT_POLICY, allowedHostShareDirectories: ["/var/lib/crucible"] };
    expect(decideHostShare(policy, "/var/lib/crucible/sample").allowed).toBe(true);
    expect(decideHostShare(policy, "/etc/passwd").allowed).toBe(false);
    expect(decideHostShare(policy, "passwd").allowed).toBe(false);
  });

  it("forces downloads to land in the configured directories", () => {
    expect(decideDownloadTarget(DEFAULT_POLICY, "artifacts/downloads/report.json").allowed).toBe(
      true,
    );
    expect(decideDownloadTarget(DEFAULT_POLICY, "/etc/passwd").allowed).toBe(false);
    expect(decideDownloadTarget(DEFAULT_POLICY, "../escape").allowed).toBe(false);
  });

  it("blocks internet egress by default", () => {
    expect(decideInternetEgress(DEFAULT_POLICY).allowed).toBe(false);
    expect(decideInternetEgress({ ...DEFAULT_POLICY, allowInternetEgress: true }).allowed).toBe(
      true,
    );
  });
});

describe("scenario runner", () => {
  it("restores pre + post snapshots around the supplied steps", async () => {
    const restored: string[] = [];
    const steps: string[] = [];
    const result = await runScenario(
      {
        id: "sample-run",
        preRestoreSnapshot: "clean-base",
        steps: [
          {
            id: "run-sample",
            title: "run sample",
            kind: "scenario-step",
            run: () => Promise.resolve(steps.push("ran")).then(() => undefined),
          },
        ],
      },
      { restoreSnapshot: (name) => Promise.resolve(restored.push(name)).then(() => undefined) },
    );
    expect(result.status).toBe("succeeded");
    expect(restored).toEqual(["clean-base", "clean-base"]);
    expect(steps).toEqual(["ran"]);
    expect(result.records.map((r) => r.id)).toEqual([
      "snapshot-restore-pre",
      "run-sample",
      "snapshot-restore-post",
    ]);
  });

  it("skips remaining steps after the first failure but still restores", async () => {
    const restored: string[] = [];
    const result = await runScenario(
      {
        id: "broken",
        preRestoreSnapshot: "clean-base",
        steps: [
          {
            id: "bad",
            title: "bad",
            kind: "scenario-step",
            run: () => Promise.reject(new Error("boom")),
          },
          {
            id: "later",
            title: "later",
            kind: "scenario-step",
            run: () => Promise.resolve(),
          },
        ],
      },
      { restoreSnapshot: (name) => Promise.resolve(restored.push(name)).then(() => undefined) },
    );
    expect(result.status).toBe("failed");
    expect(restored).toEqual(["clean-base", "clean-base"]);
    expect(result.records.map((r) => r.status)).toEqual([
      "succeeded",
      "failed",
      "skipped",
      "succeeded",
    ]);
  });

  it("skipPostRestore: true omits the trailing restore", async () => {
    const restored: string[] = [];
    const result = await runScenario(
      {
        id: "preserve",
        preRestoreSnapshot: "clean-base",
        skipPostRestore: true,
        steps: [],
      },
      { restoreSnapshot: (name) => Promise.resolve(restored.push(name)).then(() => undefined) },
    );
    expect(result.status).toBe("succeeded");
    expect(restored).toEqual(["clean-base"]);
  });
});

describe("audit aggregation", () => {
  it("merges JSONL host + guest logs in time order", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-audit-"));
    try {
      const hostLog = join(root, "host.jsonl");
      const guestLog = join(root, "guest.jsonl");
      await writeFile(
        hostLog,
        '{"time":"2026-01-01T00:00:00Z","method":"GET","path":"/host","action":"vm_status"}\n',
      );
      await writeFile(
        guestLog,
        '{"time":"2026-01-01T00:00:01Z","method":"POST","path":"/exec","action":"exec"}\n',
      );
      const events = await aggregateAuditEvents({
        hostLogs: [hostLog],
        guestLogs: [guestLog],
      });
      expect(events).toHaveLength(2);
      expect(events[0]?.source).toBe("host");
      expect(events[1]?.source).toBe("guest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tolerates missing files and malformed lines", async () => {
    const events = await aggregateAuditEvents({ hostLogs: ["/does/not/exist"] });
    expect(events).toEqual([]);
  });
});

describe("credential rotation", () => {
  it("rotates per-VM windows account passwords without touching globals", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-rotate-"));
    try {
      const result = await rotateLocalAccountCredentials({
        vmName: "rotate-vm",
        secretsDirectory: root,
      });
      expect(result.accounts).toHaveLength(2);
      const stored = await readFile(result.accounts[0]!.path, "utf8");
      const parsed = JSON.parse(stored) as { password: string };
      expect(parsed.password.length).toBeGreaterThanOrEqual(24);

      const plan = rotateGuestServiceCertificatesPlan("rotate-vm", root);
      expect(plan.caCertificatePath).toContain("rotate-vm");
      expect(plan.guestServerPrivateKeyPath).toContain("rotate-vm");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("artifact export", () => {
  it("hashes every artifact and produces a tar.gz alongside the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-export-"));
    try {
      const sample = join(root, "input.txt");
      await writeFile(sample, "hello crucible");
      const outputPath = join(root, "bundle.tar.gz");
      const result = await exportArtifactBundle({
        outputPath,
        artifacts: [{ path: sample, label: "input" }],
      });
      expect(result.entries[0]?.sizeBytes).toBe("hello crucible".length);
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
        entries: Array<{ sha256: string }>;
      };
      expect(manifest.entries[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an empty artifact list", async () => {
    await expect(
      exportArtifactBundle({
        outputPath: "/tmp/empty.tar.gz",
        artifacts: [],
      }),
    ).rejects.toThrow(/at least one artifact/);
  });
});
