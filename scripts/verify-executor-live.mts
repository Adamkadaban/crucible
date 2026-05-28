// Verify the QgaProvisioningExecutor fix against the live VM.
// Runs probe-qga, configure-policy, test-health through the real executor.
import { QgaClient, QgaProvisioningExecutor } from "../packages/core/src/index.ts";

const client = new QgaClient({
  socketPath: "artifacts/qga.sock",
  timeoutMs: 60_000,
});
const executor = new QgaProvisioningExecutor({
  client,
  vmName: "crucible-win11",
  secretsDirectory: "artifacts/secrets",
  timeoutMs: 5 * 60 * 1000,
  readinessTimeoutMs: 60_000,
  readinessPollIntervalMs: 1_000,
});

const stages = [
  {
    id: "qga-ready" as const,
    title: "QGA readiness",
    dependsOn: ["vm-booted"],
    readinessChecks: [],
    script: {
      id: "probe-qga",
      executable: "powershell.exe",
      scriptPath: "guest/provision/probe-qga.ps1",
      arguments: [],
      environmentSecretRefs: [],
      timeoutMs: 60_000,
      elevated: false,
    },
    producesSecrets: [],
    producesSnapshot: false,
  },
  {
    id: "policy-configured" as const,
    title: "Analysis policy applied",
    dependsOn: ["qga-ready"],
    readinessChecks: [],
    script: {
      id: "configure-policy",
      executable: "powershell.exe",
      scriptPath: "guest/provision/configure-policy.ps1",
      arguments: [],
      environmentSecretRefs: [],
      timeoutMs: 5 * 60 * 1000,
      elevated: true,
    },
    producesSecrets: [],
    producesSnapshot: false,
  },
  {
    id: "health-checked" as const,
    title: "Guest health",
    dependsOn: ["policy-configured"],
    readinessChecks: [],
    script: {
      id: "test-health",
      executable: "powershell.exe",
      scriptPath: "guest/provision/test-health.ps1",
      arguments: [],
      environmentSecretRefs: [],
      timeoutMs: 60_000,
      elevated: false,
    },
    producesSecrets: [],
    producesSnapshot: false,
  },
];

for (const stage of stages) {
  process.stdout.write(`\n===== ${stage.id} (${stage.script?.scriptPath})\n`);
  const start = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executor.runStage(stage as any);
    process.stdout.write(
      `status=${result.status} took=${Date.now() - start}ms detail=${(result.detail ?? "").slice(0, 400)}\n`,
    );
  } catch (err) {
    process.stdout.write(
      `THREW after ${Date.now() - start}ms: ${(err as Error).message}\n`,
    );
  }
}
