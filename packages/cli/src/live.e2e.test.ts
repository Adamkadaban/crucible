import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildProvisioningSecretStorageContract,
  SnapshotManager,
  loadCrucibleConfigFile,
  parseCrucibleConfig,
  type ArtifactManifest,
  type CrucibleConfig,
  type GuestAgentClient,
  type GuestAgentExecResult,
  type RealismPersona,
} from "@crucible/core";
import { createCrucibleMcpServer } from "@crucible/mcp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildDefaultGuestClientFactory, buildMcpVmAdapter, runCrucibleCli } from "./index.js";

const liveEnabled = process.env.CRUCIBLE_E2E_LIVE === "1";
const operatorConfigPath = process.env.CRUCIBLE_CONFIG;
const liveRoot =
  process.env.CRUCIBLE_E2E_LIVE_ROOT ?? path.join(homedir(), ".config", "crucible-live-e2e");
const liveConfigPath = path.join(liveRoot, "config.json");
const liveVmName = "crucible-live-e2e";

type ToolCallText = { content: ReadonlyArray<{ type: string; text: string }> };
type LiveContext = {
  readonly config: CrucibleConfig;
  readonly configPath: string;
  readonly guest: GuestAgentClient;
  readonly tempDir: string;
  readonly persona: RealismPersona;
  readonly manifest: ArtifactManifest;
  readonly provisionedThisRun: boolean;
};

const contexts: LiveContext[] = [];

beforeAll(
  async () => {
    if (!liveEnabled) return;
    const operatorConfig = loadCrucibleConfigFile(operatorConfigPath);
    const config = await prepareLiveE2eConfig(operatorConfig);

    let manifest = await readJsonIfExists<ArtifactManifest>(config.artifacts.manifestPath);
    const hasCleanBase = manifest?.artifacts.some(
      (artifact) => artifact.kind === "snapshot" && artifact.name === "clean-base",
    );
    const hasPersona = manifest?.artifacts.some((artifact) => artifact.kind === "persona");
    let provisionedThisRun = false;
    if (hasCleanBase !== true || hasPersona !== true) {
      await resetLiveE2eRoot(operatorConfig);
      const freshConfig = await prepareLiveE2eConfig(operatorConfig);
      const provision = await runCrucibleCli(["provision"], {
        config: freshConfig,
        configPath: liveConfigPath,
      });
      expect(provision.exitCode, `${provision.stdout}\n${provision.stderr}`).toBe(0);
      expect(provision.stdout).toContain("Provisioning status: complete");
      manifest = await readJsonIfExists<ArtifactManifest>(freshConfig.artifacts.manifestPath);
      provisionedThisRun = true;
    }

    if (manifest === undefined) throw new Error("live E2E provisioning did not write a manifest");
    const persona = await loadPersona(manifest);
    const guestFactory = buildDefaultGuestClientFactory(config);
    if (guestFactory === undefined) {
      throw new Error("live E2E requires a provisioned guest or CRUCIBLE_GUEST_* mTLS env vars");
    }

    await ensureVmRunningAtCleanBase(config, manifest, provisionedThisRun);
    const tempDir = await mkdtemp(path.join(tmpdir(), "crucible-live-e2e-"));
    const guest = (await guestFactory()) as GuestAgentClient;
    await waitForGuestHealth(guest);
    contexts.push({
      config,
      configPath: liveConfigPath,
      guest,
      tempDir,
      persona,
      manifest,
      provisionedThisRun,
    });
  },
  90 * 60 * 1000,
);

afterAll(async () => {
  for (const context of contexts.splice(0)) {
    await context.guest.close().catch(() => undefined);
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

async function prepareLiveE2eConfig(operatorConfig: CrucibleConfig): Promise<CrucibleConfig> {
  const artifactsDirectory = path.join(liveRoot, "artifacts");
  const config = parseCrucibleConfig({
    vm: {
      ...operatorConfig.vm,
      name: liveVmName,
      display: { mode: "vnc", vncSocketPath: path.join(artifactsDirectory, "vnc.sock") },
    },
    media: operatorConfig.media,
    virtio: operatorConfig.virtio,
    network: { ...operatorConfig.network, mode: "isolated", controlPort: 18443 },
    analysisPolicy: operatorConfig.analysisPolicy,
    realism: {
      enabled: true,
      seed: "crucible-live-e2e-fixed-seed",
      profile: "developer",
      installCommonSoftware: true,
      populateUserFiles: true,
      simulateUserHistory: true,
      randomizeInstallTimes: true,
    },
    qmp: { socketPath: path.join(artifactsDirectory, "qmp.sock"), timeoutMs: 10_000 },
    qga: { socketPath: path.join(artifactsDirectory, "qga.sock"), timeoutMs: 60_000 },
    artifacts: {
      directory: artifactsDirectory,
      manifestPath: path.join(artifactsDirectory, "manifest.json"),
      logsDirectory: path.join(artifactsDirectory, "logs"),
      snapshotsDirectory: path.join(liveRoot, "snapshots"),
      secretsDirectory: path.join(artifactsDirectory, "secrets"),
    },
  });
  await mkdir(liveRoot, { recursive: true });
  await writeFile(liveConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return config;
}

async function resetLiveE2eRoot(operatorConfig: CrucibleConfig): Promise<void> {
  await runCrucibleCli(["vm", "stop", "--kill"], {
    config: parseCrucibleConfig({
      ...operatorConfig,
      vm: { ...operatorConfig.vm, name: liveVmName },
      artifacts: {
        directory: path.join(liveRoot, "artifacts"),
        manifestPath: path.join(liveRoot, "artifacts", "manifest.json"),
        logsDirectory: path.join(liveRoot, "artifacts", "logs"),
        snapshotsDirectory: path.join(liveRoot, "snapshots"),
        secretsDirectory: path.join(liveRoot, "artifacts", "secrets"),
      },
      qmp: { socketPath: path.join(liveRoot, "artifacts", "qmp.sock"), timeoutMs: 10_000 },
      qga: { socketPath: path.join(liveRoot, "artifacts", "qga.sock"), timeoutMs: 60_000 },
    }),
    configPath: liveConfigPath,
  }).catch(() => undefined);
  await rm(liveRoot, { recursive: true, force: true });
}

async function ensureVmRunningAtCleanBase(
  config: CrucibleConfig,
  manifest: ArtifactManifest,
  provisionedThisRun: boolean,
): Promise<void> {
  const status = await runCrucibleCli(["vm", "status"], { config, configPath: liveConfigPath });
  expect(status.exitCode, status.stderr).toBe(0);
  const running = status.stdout.includes("status: running");
  if (provisionedThisRun && running) return;

  const cleanBase = manifest.artifacts.find(
    (artifact) => artifact.kind === "snapshot" && artifact.name === "clean-base",
  ) as { mode?: string } | undefined;
  if (running && cleanBase?.mode !== "online-qmp") {
    const stop = await runCrucibleCli(["vm", "stop", "--kill"], {
      config,
      configPath: liveConfigPath,
    });
    expect(stop.exitCode, stop.stderr).toBe(0);
  }

  const restore = await runCrucibleCli(["snapshot", "restore", "clean-base"], {
    config,
    configPath: liveConfigPath,
  });
  expect(restore.exitCode, restore.stderr).toBe(0);
  expect(restore.stdout).toContain("Snapshot restored: clean-base");

  const start = await runCrucibleCli(["vm", "start"], { config, configPath: liveConfigPath });
  expect(start.exitCode, start.stderr).toBe(0);
}

async function loadPersona(manifest: ArtifactManifest): Promise<RealismPersona> {
  const personaRecord = manifest.artifacts.find((artifact) => artifact.kind === "persona");
  if (personaRecord === undefined) throw new Error("live E2E baseline has no persona artifact");
  const persona = await readJsonIfExists<RealismPersona>(personaRecord.path);
  if (persona === undefined)
    throw new Error(`missing live E2E persona file: ${personaRecord.path}`);
  return persona;
}

function context(): LiveContext {
  const current = contexts[0];
  if (current === undefined) throw new Error("live E2E context was not initialized");
  return current;
}

function parsePayload<T>(result: ToolCallText): T {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("missing MCP text payload");
  return JSON.parse(text) as T;
}

async function expectToolOk(client: Client, name: string, args: Record<string, unknown>) {
  const payload = parsePayload<{ ok: boolean; error?: { message?: string } }>(
    (await client.callTool({ name, arguments: args })) as ToolCallText,
  );
  expect(payload.ok, payload.error?.message).toBe(true);
}

async function withLiveMcpClient<T>(
  context: LiveContext,
  clientName: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const snapshotManager = new SnapshotManager({ config: context.config });
  const server = createCrucibleMcpServer({
    config: context.config,
    configPath: liveConfigPath,
    guestClientFactory: () => Promise.resolve(context.guest),
    vmAdapter: buildMcpVmAdapter(context.config),
    snapshotAdapter: {
      list: async () =>
        (await snapshotManager.list()).map((snapshot) => ({
          name: snapshot.name,
          path: snapshot.path,
          createdAt: snapshot.createdAt,
        })),
      restore: async (snapshotName: string) => {
        const restored = await snapshotManager.restore(snapshotName);
        return {
          name: restored.snapshot.name,
          path: restored.snapshot.path,
          createdAt: restored.snapshot.createdAt,
        };
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return await operation(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function decode(result: GuestAgentExecResult): string {
  return Buffer.from(result.stdoutBase64 ?? "", "base64").toString("utf8");
}

async function expectGuestCommand(
  guest: GuestAgentClient,
  script: string,
  timeoutMs = 60_000,
): Promise<string> {
  const result = await guest.exec({
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeoutMs,
    as: "admin",
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      [
        `guest PowerShell failed with exitCode=${result.exitCode} timedOut=${result.timedOut}`,
        decode(result),
        Buffer.from(result.stderrBase64 ?? "", "base64").toString("utf8"),
      ].join("\n"),
    );
  }
  return decode(result).trim();
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForGuestHealth(guest: GuestAgentClient): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const health = await guest.health();
      if (health.status === "ok") return;
      lastError = new Error(`guest health returned ${health.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`timed out waiting for guest health: ${String(lastError)}`);
}

function parsePpmHeader(buffer: Buffer): {
  readonly width: number;
  readonly height: number;
  readonly pixelOffset: number;
} {
  const text = buffer.toString("ascii", 0, Math.min(buffer.byteLength, 512));
  const match = /^P6\s+(?:#[^\n]*\s+)*(\d+)\s+(\d+)\s+(\d+)\s/.exec(text);
  if (match === null)
    throw new Error(`screenshot is not a binary PPM/P6 image: ${text.slice(0, 32)}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const max = Number(match[3]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid PPM dimensions: ${width}x${height}`);
  }
  if (max !== 255) throw new Error(`unexpected PPM max value: ${max}`);
  return { width, height, pixelOffset: match[0].length };
}

function countDistinctSampledPixels(buffer: Buffer, pixelOffset: number): number {
  const pixels = buffer.subarray(pixelOffset);
  const seen = new Set<string>();
  const samples = Math.min(256, Math.floor(pixels.byteLength / 3));
  if (samples === 0) return 0;
  const stride = Math.max(3, Math.floor(pixels.byteLength / samples / 3) * 3);
  for (let offset = 0; offset + 2 < pixels.byteLength && seen.size < 8; offset += stride) {
    seen.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
  }
  return seen.size;
}

describe.runIf(liveEnabled)("Crucible live VM acceptance E2E", () => {
  it("starts/restores the real VM and verifies CLI status plus guest health", async () => {
    const { config, guest } = context();
    const status = await runCrucibleCli(["vm", "status"], { config, configPath: liveConfigPath });
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain("status: running");

    const snapshots = await runCrucibleCli(["snapshot", "list"], {
      config,
      configPath: liveConfigPath,
    });
    expect(snapshots.exitCode, snapshots.stderr).toBe(0);
    expect(snapshots.stdout).toContain("clean-base");

    const health = await guest.health();
    expect(health.status).toBe("ok");
    expect(health.hostName.length).toBeGreaterThan(0);
  });

  it("verifies realism metadata, hostname, decoy files, inert secrets, and software markers", async () => {
    const { config, guest, manifest, persona } = context();
    expect(
      manifest.artifacts.some(
        (artifact) => artifact.kind === "snapshot" && artifact.name === "clean-base",
      ),
    ).toBe(true);

    const hostname = await expectGuestCommand(guest, "$env:COMPUTERNAME");
    expect(hostname.toUpperCase()).toBe(persona.hostname.toUpperCase());
    expect(hostname.toUpperCase()).not.toBe(config.vm.name.toUpperCase());

    const accountScript = [
      `$standard = Get-LocalUser -Name '${escapePowerShell(persona.userUsername)}'`,
      `$admin = Get-LocalUser -Name '${escapePowerShell(persona.adminUsername)}'`,
      `[pscustomobject]@{Standard=$standard.Enabled; Admin=$admin.Enabled} | ConvertTo-Json -Compress`,
    ].join("; ");
    const accountState = JSON.parse(await expectGuestCommand(guest, accountScript)) as {
      Standard: boolean;
      Admin: boolean;
    };
    expect(accountState).toEqual({ Standard: true, Admin: true });

    const sampleDecoys = persona.decoyFiles.slice(0, Math.min(persona.decoyFiles.length, 6));
    expect(sampleDecoys.length).toBeGreaterThan(0);
    for (const decoy of sampleDecoys) {
      const guestPath = `C:\\Users\\${persona.userUsername}\\${decoy.relativePath}`;
      const script = [
        `$p = '${escapePowerShell(guestPath)}'`,
        `if (-not (Test-Path -LiteralPath $p)) { throw "missing $p" }`,
        `$c = Get-Content -LiteralPath $p -Raw`,
        `[pscustomobject]@{Length=$c.Length; ContainsInert=$c.Contains('INERT') -or $c.Contains('not-a-real-secret'); ContainsOwner=$c.Contains('${escapePowerShell(persona.fullName)}')} | ConvertTo-Json -Compress`,
      ].join("; ");
      const fileState = JSON.parse(await expectGuestCommand(guest, script)) as {
        Length: number;
        ContainsInert: boolean;
        ContainsOwner: boolean;
      };
      expect(fileState.Length).toBeGreaterThan(0);
      if (decoy.category === "inert-secret") expect(fileState.ContainsInert).toBe(true);
      if (decoy.category === "ordinary-user") expect(fileState.ContainsOwner).toBe(true);
    }

    const sampleSoftware = persona.softwareMarkers.slice(
      0,
      Math.min(persona.softwareMarkers.length, 6),
    );
    expect(sampleSoftware.length).toBeGreaterThan(0);
    for (const marker of sampleSoftware) {
      const keyName = escapePowerShell(marker.name);
      const script = [
        `$roots = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')`,
        `$hit = Get-ChildItem -Path $roots -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -eq '${keyName}' } | Select-Object -First 1`,
        `if ($null -eq $hit) { throw 'missing software marker ${keyName}' }`,
        `$hit.DisplayName`,
      ].join("; ");
      await expect(expectGuestCommand(guest, script)).resolves.toBe(marker.name);
    }

    const contract = buildProvisioningSecretStorageContract(
      config.vm.name,
      config.artifacts.secretsDirectory,
    );
    await expect(stat(contract.rootDirectory)).resolves.toMatchObject({});
  });

  it("captures and validates real screenshots through CLI-backed MCP", async () => {
    const live = context();
    const { tempDir } = live;
    await withLiveMcpClient(live, "crucible-live-acceptance", async (client) => {
      const display = parsePayload<{
        ok: boolean;
        result: { available: boolean; inputAvailable: boolean };
      }>((await client.callTool({ name: "vm_display_info", arguments: {} })) as ToolCallText);
      expect(display.ok).toBe(true);
      expect(display.result.available).toBe(true);
      expect(display.result.inputAvailable).toBe(true);

      const screenshotPath = path.join(tempDir, `screen-${Date.now()}.ppm`);
      const screenshot = parsePayload<{ ok: boolean; result: { path: string; sizeBytes: number } }>(
        (await client.callTool({
          name: "vm_screenshot",
          arguments: { outputPath: screenshotPath },
        })) as ToolCallText,
      );
      expect(screenshot.ok).toBe(true);
      expect(screenshot.result.path).toBe(screenshotPath);
      expect(screenshot.result.sizeBytes).toBeGreaterThan(1024);

      const image = await readFile(screenshotPath);
      const dimensions = parsePpmHeader(image);
      expect(dimensions.width).toBeGreaterThanOrEqual(640);
      expect(dimensions.height).toBeGreaterThanOrEqual(480);
      expect(image.byteLength).toBeGreaterThanOrEqual(
        dimensions.pixelOffset + dimensions.width * dimensions.height * 3,
      );
      expect(countDistinctSampledPixels(image, dimensions.pixelOffset)).toBeGreaterThan(1);
    });
  });

  it("exercises safe live MCP lifecycle, network, snapshot, and guest file tools", async () => {
    const live = context();
    const marker = `mcp-live-${randomUUID()}`;
    const hostUploadPath = path.join(live.tempDir, `${marker}.txt`);
    const guestPath = `C:\\ProgramData\\Crucible\\staging\\${marker}.txt`;
    const hostDownloadPath = `artifacts/downloads/live-e2e-${marker}.txt`;
    await writeFile(hostUploadPath, `${marker}\n`, "utf8");

    await withLiveMcpClient(live, "crucible-live-tools", async (client) => {
      const status = parsePayload<{ ok: boolean; result: { state: string; pid?: number } }>(
        (await client.callTool({ name: "vm_status", arguments: {} })) as ToolCallText,
      );
      expect(status.ok).toBe(true);
      expect(status.result.state).toBe("running");
      expect(status.result.pid).toBeGreaterThan(0);

      const snapshots = parsePayload<{ ok: boolean; result: ReadonlyArray<{ name: string }> }>(
        (await client.callTool({ name: "snapshot_list", arguments: {} })) as ToolCallText,
      );
      expect(snapshots.ok).toBe(true);
      expect(snapshots.result.some((snapshot) => snapshot.name === "clean-base")).toBe(true);

      const network = parsePayload<{
        ok: boolean;
        result: {
          configuredMode: string;
          backend: string;
          controlPort: number;
          guestEgress: string;
          liveSwitchSupported: boolean;
          restartRequiredToChangeMode: boolean;
        };
      }>((await client.callTool({ name: "network_status", arguments: {} })) as ToolCallText);
      expect(network.ok).toBe(true);
      expect(network.result.configuredMode).toBe("isolated");
      expect(network.result.backend).toBe("user");
      expect(network.result.controlPort).toBe(live.config.network.controlPort);
      expect(network.result.guestEgress).toBe("denied");
      expect(network.result.liveSwitchSupported).toBe(false);
      expect(network.result.restartRequiredToChangeMode).toBe(true);

      const activeNetwork = parsePayload<{
        ok: boolean;
        result: { configuredMode: string; activeMode: string; matchesConfiguredMode: boolean };
      }>((await client.callTool({ name: "network_active_status", arguments: {} })) as ToolCallText);
      expect(activeNetwork.ok).toBe(true);
      expect(activeNetwork.result.configuredMode).toBe("isolated");
      expect(activeNetwork.result.activeMode).toBe("isolated");
      expect(activeNetwork.result.matchesConfiguredMode).toBe(true);

      const pcap = parsePayload<{ ok: boolean; result: { exists: boolean } }>(
        (await client.callTool({ name: "network_pcap_info", arguments: {} })) as ToolCallText,
      );
      expect(pcap.ok).toBe(true);
      expect(pcap.result.exists).toBe(false);

      const health = parsePayload<{ ok: boolean; result: { status: string; hostName: string } }>(
        (await client.callTool({ name: "guest_health", arguments: {} })) as ToolCallText,
      );
      expect(health.ok).toBe(true);
      expect(health.result.status).toBe("ok");
      expect(health.result.hostName.toUpperCase()).toBe(live.persona.hostname.toUpperCase());

      const exec = parsePayload<{
        ok: boolean;
        result: { exitCode: number; stdoutBase64?: string };
      }>(
        (await client.callTool({
          name: "guest_exec",
          arguments: {
            executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            arguments: ["-NoProfile", "-Command", "Write-Output service-ok"],
            timeoutMs: 30_000,
          },
        })) as ToolCallText,
      );
      expect(exec.ok).toBe(true);
      expect(exec.result.exitCode).toBe(0);
      expect(Buffer.from(exec.result.stdoutBase64 ?? "", "base64").toString("utf8")).toContain(
        "service-ok",
      );

      const adminExec = parsePayload<{
        ok: boolean;
        result: { exitCode: number; stdoutBase64?: string };
      }>(
        (await client.callTool({
          name: "guest_exec_admin",
          arguments: {
            executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            arguments: [
              "-NoProfile",
              "-Command",
              "[Security.Principal.WindowsIdentity]::GetCurrent().Name",
            ],
            timeoutMs: 30_000,
          },
        })) as ToolCallText,
      );
      expect(adminExec.ok).toBe(true);
      expect(adminExec.result.exitCode).toBe(0);
      expect(Buffer.from(adminExec.result.stdoutBase64 ?? "", "base64").toString("utf8")).toContain(
        live.persona.adminUsername,
      );

      const upload = parsePayload<{ ok: boolean; result: { path: string; sha256: string } }>(
        (await client.callTool({
          name: "guest_upload_file",
          arguments: { hostPath: hostUploadPath, guestPath },
        })) as ToolCallText,
      );
      expect(upload.ok).toBe(true);
      expect(upload.result.path).toBe(guestPath);
      expect(upload.result.sha256).toMatch(/^[a-f0-9]{64}$/u);

      const read = parsePayload<{
        ok: boolean;
        result: { inline: boolean; contents?: string; sizeBytes: number };
      }>(
        (await client.callTool({
          name: "guest_read_file",
          arguments: { sourcePath: guestPath },
        })) as ToolCallText,
      );
      expect(read.ok).toBe(true);
      expect(read.result.inline).toBe(true);
      expect(read.result.contents).toBe(`${marker}\n`);
      expect(read.result.sizeBytes).toBeGreaterThan(0);

      const download = parsePayload<{
        ok: boolean;
        result: { guestPath: string; hostPath: string; sizeBytes: number; sha256: string };
      }>(
        (await client.callTool({
          name: "guest_download_file",
          arguments: { guestPath, hostPath: hostDownloadPath },
        })) as ToolCallText,
      );
      expect(download.ok).toBe(true);
      expect(download.result.guestPath).toBe(guestPath);
      expect(download.result.hostPath).toBe(hostDownloadPath);
      expect(download.result.sizeBytes).toBe(Buffer.byteLength(`${marker}\n`));
      expect(download.result.sha256).toBe(upload.result.sha256);
      await expect(readFile(hostDownloadPath, "utf8")).resolves.toBe(`${marker}\n`);

      await expectToolOk(client, "vm_mouse_drag", {
        fromX: 12_000,
        fromY: 12_000,
        toX: 16_000,
        toY: 16_000,
        button: "left",
      });
    });
  });

  it("moves, clicks, double-clicks, right-clicks, types text, and verifies the GUI result", async () => {
    const live = context();
    const marker = `cruciblelivee2e${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    await withLiveMcpClient(live, "crucible-live-input", async (client) => {
      await expectToolOk(client, "vm_key_press", { key: "esc" }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expectToolOk(client, "vm_key_press", { key: "meta_l-r" });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const beforeTyping = await captureScreenshot(client, live.tempDir, "before-typing");
      await expectToolOk(client, "vm_type_text", {
        text: marker,
        delayMs: 15,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const afterTyping = await captureScreenshot(client, live.tempDir, "after-typing");
      expect(countSampledPixelByteDifferences(beforeTyping, afterTyping)).toBeGreaterThan(100);

      await expectToolOk(client, "vm_key_press", { key: "esc" }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expectToolOk(client, "vm_mouse_move", { x: 24_000, y: 12_000 });
      await expectToolOk(client, "vm_mouse_click", { x: 24_000, y: 12_000, button: "left" });
      await expectToolOk(client, "vm_mouse_double_click", {
        x: 24_000,
        y: 12_000,
        button: "left",
      });
      await expectToolOk(client, "vm_mouse_click", { x: 28_000, y: 12_000, button: "right" });
      await expectToolOk(client, "vm_key_press", { key: "esc" }).catch(() => undefined);
    });
  });
});

async function captureScreenshot(client: Client, tempDir: string, label: string): Promise<Buffer> {
  const screenshotPath = path.join(tempDir, `${label}-${Date.now()}.ppm`);
  const screenshot = parsePayload<{ ok: boolean; result: { path: string; sizeBytes: number } }>(
    (await client.callTool({
      name: "vm_screenshot",
      arguments: { outputPath: screenshotPath },
    })) as ToolCallText,
  );
  expect(screenshot.ok).toBe(true);
  expect(screenshot.result.path).toBe(screenshotPath);
  expect(screenshot.result.sizeBytes).toBeGreaterThan(1024);
  return readFile(screenshotPath);
}

function countSampledPixelByteDifferences(left: Buffer, right: Buffer): number {
  const leftHeader = parsePpmHeader(left);
  const rightHeader = parsePpmHeader(right);
  expect(rightHeader.width).toBe(leftHeader.width);
  expect(rightHeader.height).toBe(leftHeader.height);
  const leftPixels = left.subarray(leftHeader.pixelOffset);
  const rightPixels = right.subarray(rightHeader.pixelOffset);
  const length = Math.min(leftPixels.byteLength, rightPixels.byteLength);
  let differences = 0;
  for (let offset = 0; offset < length; offset += 1) {
    if (leftPixels[offset] !== rightPixels[offset]) differences += 1;
  }
  return differences;
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}
