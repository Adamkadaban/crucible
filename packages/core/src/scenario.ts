// Scenario runner. A scenario codifies the operator workflow for running
// an analysis sample inside the VM: restore a clean snapshot, run sample
// steps, capture artifacts, and (optionally) restore again. Steps can be
// arbitrary async callbacks but the runner enforces the policy that a
// scenario must restore *before* and *after* execution unless explicitly
// opted out.

import { decideDownloadTarget, decideHostShare, decideInternetEgress } from "./policy.js";

export type ScenarioStepKind = "snapshot-restore-pre" | "scenario-step" | "snapshot-restore-post";

export type ScenarioStep = {
  readonly id: string;
  readonly title: string;
  readonly kind: ScenarioStepKind;
  readonly run: () => Promise<void>;
};

export type ScenarioInput = {
  readonly id: string;
  readonly preRestoreSnapshot: string;
  readonly steps: readonly ScenarioStep[];
  readonly postRestoreSnapshot?: string;
  readonly skipPostRestore?: boolean;
};

export type ScenarioStepRecord = {
  readonly id: string;
  readonly title: string;
  readonly kind: ScenarioStepKind;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly error?: string;
  readonly durationMs: number;
};

export type ScenarioResult = {
  readonly scenarioId: string;
  readonly status: "succeeded" | "failed";
  readonly records: readonly ScenarioStepRecord[];
};

export type ScenarioRunnerOptions = {
  readonly restoreSnapshot: (snapshotName: string) => Promise<void>;
  readonly now?: () => number;
};

/**
 * Drive a scenario through its lifecycle. Restore-before-execution is
 * mandatory; restore-after-execution is the default and can only be
 * disabled by explicitly passing `skipPostRestore: true`.
 */
export async function runScenario(
  input: ScenarioInput,
  options: ScenarioRunnerOptions,
): Promise<ScenarioResult> {
  const records: ScenarioStepRecord[] = [];
  const now = options.now ?? (() => Date.now());

  const preStep: ScenarioStep = {
    id: "snapshot-restore-pre",
    title: `restore snapshot ${input.preRestoreSnapshot} before execution`,
    kind: "snapshot-restore-pre",
    run: () => options.restoreSnapshot(input.preRestoreSnapshot),
  };
  const postSnapshot = input.postRestoreSnapshot ?? input.preRestoreSnapshot;
  const postStep: ScenarioStep | undefined = input.skipPostRestore
    ? undefined
    : {
        id: "snapshot-restore-post",
        title: `restore snapshot ${postSnapshot} after execution`,
        kind: "snapshot-restore-post",
        run: () => options.restoreSnapshot(postSnapshot),
      };

  const ordered: readonly ScenarioStep[] = [
    preStep,
    ...input.steps.map((step): ScenarioStep => ({ ...step, kind: "scenario-step" })),
  ];

  let failed = false;
  for (const step of ordered) {
    const started = now();
    if (failed) {
      records.push({
        id: step.id,
        title: step.title,
        kind: step.kind,
        status: "skipped",
        durationMs: 0,
      });
      continue;
    }
    try {
      await step.run();
      records.push({
        id: step.id,
        title: step.title,
        kind: step.kind,
        status: "succeeded",
        durationMs: now() - started,
      });
    } catch (err) {
      failed = true;
      records.push({
        id: step.id,
        title: step.title,
        kind: step.kind,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: now() - started,
      });
    }
  }

  if (postStep !== undefined) {
    const started = now();
    try {
      await postStep.run();
      records.push({
        id: postStep.id,
        title: postStep.title,
        kind: postStep.kind,
        status: "succeeded",
        durationMs: now() - started,
      });
    } catch (err) {
      failed = true;
      records.push({
        id: postStep.id,
        title: postStep.title,
        kind: postStep.kind,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: now() - started,
      });
    }
  }

  return {
    scenarioId: input.id,
    status: failed ? "failed" : "succeeded",
    records,
  };
}

/** Re-export so callers can drive policy denials inside a scenario step. */
export { decideDownloadTarget, decideHostShare, decideInternetEgress };
