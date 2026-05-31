import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  CRUCIBLE_VERSION,
  CrucibleError,
  DebuggerSessionManager,
  buildNetworkModeChangePlan,
  buildNetworkPlan,
  buildNetworkRuntimeStatus,
  type CrucibleConfig,
  type CruciblePolicy,
  defaultCrucibleConfig,
  DEFAULT_POLICY,
  decideDownloadTarget,
  type DebuggerSession,
  type DebuggerSessionSpec,
  GuestAgentClient,
  type GuestAgentClientOptions,
  type GuestAgentExecRequest,
  type GuestAgentExecResult,
  type GuestAgentFileInspection,
  type GuestAgentHealth,
  type GuestAgentUploadResult,
  type HostCheckProbeResult,
  type NetworkMode,
  runHostCheck,
} from "@crucible/core";

export type CrucibleToolDefinition = {
  readonly name: string;
  readonly description: string;
};

export const BOOTSTRAP_TOOLS: readonly CrucibleToolDefinition[] = [
  {
    name: "host_check",
    description: "Report Linux host prerequisites for QEMU/KVM-based Windows analysis VMs.",
  },
  {
    name: "vm_status",
    description: "Read the lifecycle state of the configured Crucible VM from its state manifest.",
  },
  {
    name: "vm_start",
    description:
      "Start the configured long-lived Crucible VM. For a new analysis session, call snapshot_restore(clean-base) after the guest agent is reachable.",
  },
  {
    name: "vm_stop",
    description: "Stop the configured Crucible VM through the injected lifecycle manager.",
  },
  {
    name: "network_status",
    description: "Report configured VM network mode and live-switch capability.",
  },
  {
    name: "network_set_mode",
    description: "Plan a network mode change and report whether a VM restart is required.",
  },
  {
    name: "network_active_status",
    description: "Compare configured network mode with the active persisted QEMU network args.",
  },
  {
    name: "network_pcap_info",
    description: "Report capture pcap artifact path, size, and availability.",
  },
  {
    name: "tshark_summary",
    description: "Summarize a pcap artifact with host-side tshark when installed.",
  },
  {
    name: "snapshot_list",
    description: "List qcow2 snapshots tracked by Crucible for the configured VM.",
  },
  {
    name: "snapshot_restore",
    description:
      "Restore a named snapshot. Agents should restore clean-base before each new analysis session unless intentionally continuing a live investigation.",
  },
  {
    name: "guest_health",
    description: "Report guest service readiness once a VM has been provisioned.",
  },
  {
    name: "guest_exec",
    description: "Run a process inside the Windows guest via the Crucible guest agent.",
  },
  {
    name: "guest_exec_admin",
    description: "Run a process as the provisioned Windows admin account.",
  },
  {
    name: "guest_upload_file",
    description: "Stream a local host file path into the guest.",
  },
  {
    name: "guest_read_file",
    description:
      "Read a small ASCII guest file inline, or report size and header metadata for large/binary files.",
  },
  {
    name: "guest_download_file",
    description:
      "Stream a guest file and write it to a local host path. Prefer this when saving artifacts.",
  },
  {
    name: "debug_open",
    description: "Open a CDB-backed debugger session against a guest process (launch or attach).",
  },
  {
    name: "debug_command",
    description: "Run one or more CDB commands inside an open debugger session.",
  },
  {
    name: "debug_dump",
    description: "Capture a user-mode dump file for a debugger session target.",
  },
  {
    name: "debug_run_script",
    description: "Run a multi-line CDB script in a temporary persistent debugger session.",
  },
  {
    name: "dump_process",
    description:
      "Capture a user-mode process dump without attaching CDB, using ProcDump when available.",
  },
  {
    name: "process_monitor_start",
    description: "Start optional ProcMon-backed process/file/registry/network monitoring.",
  },
  {
    name: "process_monitor_stop",
    description: "Stop a ProcMon-backed monitor and summarize captured CSV output.",
  },
  {
    name: "memory_scan",
    description: "Scan a process memory for ASCII or hex byte patterns without attaching CDB.",
  },
  {
    name: "memory_dump_region",
    description: "Dump a process memory region to a guest file without attaching CDB.",
  },
  {
    name: "debug_close",
    description: "Close an open debugger session and discard its transcript.",
  },
];

export function getMcpServerBanner(): string {
  return `crucible MCP server ${CRUCIBLE_VERSION}`;
}

/** Per-tool error envelope returned in the structured response. */
export type CrucibleToolErrorKind =
  | "validation"
  | "host-prerequisite"
  | "vm-offline"
  | "guest-failed"
  | "timeout"
  | "policy-denied"
  | "internal";

export type CrucibleToolError = {
  readonly kind: CrucibleToolErrorKind;
  readonly message: string;
  readonly auditLogPath?: string;
};

const GuestExecInput = z
  .object({
    executable: z.string().min(1),
    arguments: z.array(z.string()).max(64).optional(),
    workingDirectory: z.string().optional(),
    environment: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().max(1_800_000).optional(),
    as: z.enum(["service", "standard", "admin"]).optional(),
  })
  .strict();
type GuestExecInputType = z.infer<typeof GuestExecInput>;

const GuestUploadFileInput = z
  .object({
    hostPath: z.string().min(1),
    guestPath: z.string().min(1),
  })
  .strict();
type GuestUploadFileInputType = z.infer<typeof GuestUploadFileInput>;

const GuestReadFileInput = z
  .object({
    sourcePath: z.string().min(1),
  })
  .strict();
type GuestReadFileInputType = z.infer<typeof GuestReadFileInput>;

const GuestDownloadFileInput = z
  .object({
    guestPath: z.string().min(1),
    hostPath: z.string().min(1),
  })
  .strict();
type GuestDownloadFileInputType = z.infer<typeof GuestDownloadFileInput>;

const HostCheckInput = z.object({}).strict();
const GuestHealthInput = z.object({}).strict();
const VmStatusInput = z.object({}).strict();
const VmStartInput = z.object({}).strict();
const VmStopInput = z.object({}).strict();
const NetworkStatusInput = z.object({}).strict();
const NetworkSetModeInput = z.object({ mode: z.enum(["isolated", "nat", "capture"]) }).strict();
type NetworkSetModeInputType = z.infer<typeof NetworkSetModeInput>;
const NetworkActiveStatusInput = z.object({}).strict();
const NetworkPcapInfoInput = z.object({}).strict();
const TsharkSummaryInput = z
  .object({
    pcapPath: z.string().min(1).optional(),
  })
  .strict();
type TsharkSummaryInputType = z.infer<typeof TsharkSummaryInput>;
const SnapshotListInput = z.object({}).strict();
const SnapshotRestoreInput = z
  .object({
    snapshotName: z.string().min(1),
  })
  .strict();
type SnapshotRestoreInputType = z.infer<typeof SnapshotRestoreInput>;

const DebugOpenInput = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("launch"),
      executable: z.string().min(1),
      arguments: z.array(z.string()).max(64).optional(),
      symbolPath: z.string().optional(),
      arch: z.enum(["x86", "x64"]).optional(),
      debuggerArch: z.enum(["auto", "x86", "x64"]).optional(),
      initialCommands: z.array(z.string().min(1)).max(64).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("attach"),
      pid: z.number().int().positive(),
      symbolPath: z.string().optional(),
      arch: z.enum(["x86", "x64"]).optional(),
      debuggerArch: z.enum(["auto", "x86", "x64"]).optional(),
      initialCommands: z.array(z.string().min(1)).max(64).optional(),
    })
    .strict(),
]);
type _DebugOpenInputType = z.infer<typeof DebugOpenInput>;

const DebugCommandInput = z
  .object({
    sessionId: z.string().min(1),
    commands: z.array(z.string().min(1)).min(1).max(32),
    waitMs: z.number().int().positive().max(30_000).optional(),
  })
  .strict();
type DebugCommandInputType = z.infer<typeof DebugCommandInput>;

const DebugDumpInput = z
  .object({
    sessionId: z.string().min(1),
    outputGuestPath: z.string().min(1),
    minidump: z.boolean().optional(),
  })
  .strict();
type DebugDumpInputType = z.infer<typeof DebugDumpInput>;

const DebugRunScriptInput = z
  .object({
    target: DebugOpenInput,
    script: z
      .string()
      .min(1)
      .max(32 * 1024),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
    logPath: z.string().min(1).optional(),
  })
  .strict();
type DebugRunScriptInputType = z.infer<typeof DebugRunScriptInput>;

const DumpProcessInput = z
  .object({
    pid: z.number().int().positive(),
    outputGuestPath: z.string().min(1).optional(),
    full: z.boolean().optional(),
    dumpType: z.enum(["mini", "full"]).optional(),
    method: z.enum(["auto", "procdump", "comsvcs", "minidumpwritedump"]).optional(),
    suspend: z.boolean().optional(),
  })
  .strict();
type DumpProcessInputType = z.infer<typeof DumpProcessInput>;

const ProcessMonitorStartInput = z
  .object({
    targetPid: z.number().int().positive().optional(),
  })
  .strict();
type ProcessMonitorStartInputType = z.infer<typeof ProcessMonitorStartInput>;

const ProcessMonitorStopInput = z
  .object({
    monitorId: z.string().min(1),
  })
  .strict();
type ProcessMonitorStopInputType = z.infer<typeof ProcessMonitorStopInput>;

const MemoryScanInput = z
  .object({
    pid: z.number().int().positive(),
    patterns: z.array(z.string().min(1).max(512)).min(1).max(64),
    regions: z.enum(["all", "private", "image", "mapped"]).optional(),
    maxMatches: z.number().int().positive().max(1000).optional(),
  })
  .strict();
type MemoryScanInputType = z.infer<typeof MemoryScanInput>;

const MemoryDumpRegionInput = z
  .object({
    pid: z.number().int().positive(),
    baseAddress: z.string().min(1),
    size: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    outputGuestPath: z.string().min(1),
  })
  .strict();
type MemoryDumpRegionInputType = z.infer<typeof MemoryDumpRegionInput>;

const DebugCloseInput = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
type DebugCloseInputType = z.infer<typeof DebugCloseInput>;

export type VmLifecycleSnapshot = {
  readonly state: string;
  readonly pid?: number;
  readonly startedAt?: string;
};

export type SnapshotInfo = {
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
};

/**
 * Pluggable surfaces — every adapter is optional so the CLI can wire real
 * implementations while tests inject fakes.
 */
export type CrucibleVmAdapter = {
  readonly status: () => Promise<VmLifecycleSnapshot>;
  readonly start: () => Promise<VmLifecycleSnapshot>;
  readonly stop: () => Promise<VmLifecycleSnapshot>;
};

export type CrucibleSnapshotAdapter = {
  readonly list: () => Promise<readonly SnapshotInfo[]>;
  readonly restore: (snapshotName: string) => Promise<SnapshotInfo>;
};

export type RegisterCrucibleToolsOptions = {
  readonly server: McpServer;
  readonly hostCheck?: () => Promise<HostCheckProbeResult>;
  readonly guestClientFactory?: () => Promise<GuestAgentClient>;
  readonly vmAdapter?: CrucibleVmAdapter;
  readonly snapshotAdapter?: CrucibleSnapshotAdapter;
  readonly debuggerManager?: DebuggerSessionManager;
  readonly auditLogPath?: string;
  readonly config?: CrucibleConfig;
  readonly networkMode?: NetworkMode;
  readonly policy?: CruciblePolicy;
};

/**
 * Register the bootstrap MCP tools on the supplied server.
 *
 * Optional dependencies are injected so tests can drive the same handlers
 * without spawning QEMU. In production callers wire a real
 * GuestAgentClient, lifecycle/snapshot adapters, and host probe.
 */
export function registerCrucibleTools(options: RegisterCrucibleToolsOptions): void {
  const { server, vmAdapter, snapshotAdapter, auditLogPath } = options;
  const hostCheck = options.hostCheck ?? runHostCheck;
  const guestClientFactory = options.guestClientFactory;
  const policy = options.policy ?? DEFAULT_POLICY;

  server.registerTool(
    "host_check",
    {
      title: "Check host prerequisites",
      description:
        "Verify the Linux host has QEMU/KVM, OVMF, and other binaries required to run a Crucible analysis VM.",
      inputSchema: HostCheckInput.shape,
    },
    async () => {
      try {
        const result = await hostCheck();
        if (!result.healthy) {
          return toJsonContent({
            ok: false,
            error: {
              kind: "host-prerequisite" as const,
              message: result.notes ?? "host prerequisites missing",
              auditLogPath,
            },
            result,
          });
        }
        return toJsonContent({ ok: true, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError("host-prerequisite", error, auditLogPath),
        });
      }
    },
  );

  registerVmTools(server, vmAdapter, auditLogPath);
  registerNetworkTools(
    server,
    options.config ?? defaultCrucibleConfig,
    options.networkMode ?? options.config?.network.mode ?? defaultCrucibleConfig.network.mode,
    auditLogPath,
  );
  registerSnapshotTools(server, snapshotAdapter, auditLogPath);
  registerDebuggerTools(server, options.debuggerManager, guestClientFactory, auditLogPath);
  registerDumpTools(server, guestClientFactory, auditLogPath);
  registerMonitorTools(server, guestClientFactory, auditLogPath);
  registerMemoryTools(server, guestClientFactory, auditLogPath);

  server.registerTool(
    "guest_health",
    {
      title: "Guest service health",
      description: "Call /health on the Crucible guest agent and return the structured response.",
      inputSchema: GuestHealthInput.shape,
    },
    async () => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const result: GuestAgentHealth = await client.health();
        return toJsonContent({ ok: true, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "guest_exec",
    {
      title: "Run a guest command",
      description:
        "Execute a process inside the Windows guest with bounded timeout / output. Mirrors POST /exec on the guest agent.",
      inputSchema: GuestExecInput.shape,
    },
    async (input: GuestExecInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const req: GuestAgentExecRequest = {
          executable: input.executable,
          arguments: input.arguments,
          workingDirectory: input.workingDirectory,
          environment: input.environment,
          timeoutMs: input.timeoutMs,
          as: input.as ?? "service",
        };
        const result: GuestAgentExecResult = await client.exec(req);
        return toJsonContent({ ok: true, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "guest_exec_admin",
    {
      title: "Run a guest command as admin",
      description:
        "Execute a process as the provisioned Windows admin account without interactive UAC prompts.",
      inputSchema: GuestExecInput.omit({ as: true }).shape,
    },
    async (input: Omit<GuestExecInputType, "as">) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const req: GuestAgentExecRequest = {
          executable: input.executable,
          arguments: input.arguments,
          workingDirectory: input.workingDirectory,
          environment: input.environment,
          timeoutMs: input.timeoutMs,
          as: "admin",
        };
        const result: GuestAgentExecResult = await client.exec(req);
        return toJsonContent({ ok: true, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "guest_upload_file",
    {
      title: "Upload host file to guest",
      description:
        "Stream a local host file to a guest path using gzip over the guest agent transfer endpoint.",
      inputSchema: GuestUploadFileInput.shape,
    },
    async (input: GuestUploadFileInputType) => {
      try {
        if (!path.isAbsolute(input.hostPath)) {
          return validationError("hostPath must be absolute", auditLogPath);
        }
        const info = await stat(input.hostPath);
        if (!info.isFile()) {
          return validationError(`hostPath is not a regular file: ${input.hostPath}`, auditLogPath);
        }
        const client = await requireGuestClient(guestClientFactory);
        const result: GuestAgentUploadResult = await client.uploadFile(
          input.hostPath,
          input.guestPath,
        );
        return toJsonContent({ ok: true, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyFileTransferError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "guest_read_file",
    {
      title: "Read guest file",
      description:
        "Read a guest file inline only when it is small ASCII text. Large or binary files return size and header metadata instead.",
      inputSchema: GuestReadFileInput.shape,
    },
    async (input: GuestReadFileInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const inspection = await client.inspect(input.sourcePath);
        if (inspection.sizeBytes > INLINE_READ_LIMIT_BYTES) {
          return toJsonContent({
            ok: true,
            result: {
              ...inspection,
              sourcePath: input.sourcePath,
              inline: false,
              reason: "too-large",
            },
            auditLogPath,
          });
        }
        const buffer = await client.download(input.sourcePath);
        const preview = summarizeGuestFile(buffer, inspection);
        return toJsonContent({
          ok: true,
          result: {
            sourcePath: input.sourcePath,
            ...preview,
          },
          auditLogPath,
        });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "guest_download_file",
    {
      title: "Download guest file to host path",
      description:
        "Stream a guest file into a local host path using gzip over the guest agent transfer endpoint.",
      inputSchema: GuestDownloadFileInput.shape,
    },
    async (input: GuestDownloadFileInputType) => {
      try {
        const decision = decideDownloadTarget(policy, input.hostPath);
        if (!decision.allowed) {
          return validationError(decision.reason, auditLogPath);
        }
        await mkdir(path.dirname(input.hostPath), { recursive: true });
        await writeFile(input.hostPath, Buffer.alloc(0), { flag: "wx" });
        await rm(input.hostPath, { force: true });
        const client = await requireGuestClient(guestClientFactory);
        const transfer = await client.downloadFile(input.guestPath, input.hostPath);
        const info = await stat(input.hostPath);
        return toJsonContent({
          ok: true,
          result: {
            guestPath: input.guestPath,
            hostPath: input.hostPath,
            sizeBytes: info.size,
            sha256: transfer.sha256,
          },
          auditLogPath,
        });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyFileTransferError(error), error, auditLogPath),
        });
      }
    },
  );
}

function registerVmTools(
  server: McpServer,
  vm: CrucibleVmAdapter | undefined,
  auditLogPath: string | undefined,
): void {
  const wrap = async (operation: () => Promise<VmLifecycleSnapshot>) => {
    if (vm === undefined) {
      return toJsonContent({
        ok: false,
        error: {
          kind: "vm-offline" as const,
          message: "VM adapter is not configured; cannot inspect or control the VM",
          auditLogPath,
        },
      });
    }
    try {
      const result = await operation();
      return toJsonContent({ ok: true, result, auditLogPath });
    } catch (error) {
      return toJsonContent({
        ok: false,
        error: toToolError(classifyError(error), error, auditLogPath),
      });
    }
  };
  server.registerTool(
    "vm_status",
    {
      title: "VM lifecycle status",
      description: "Read the persisted lifecycle state of the configured Crucible VM.",
      inputSchema: VmStatusInput.shape,
    },
    () => wrap(() => vm!.status()),
  );
  server.registerTool(
    "vm_start",
    {
      title: "Start the VM",
      description: "Start the configured Crucible VM through the lifecycle manager.",
      inputSchema: VmStartInput.shape,
    },
    () => wrap(() => vm!.start()),
  );
  server.registerTool(
    "vm_stop",
    {
      title: "Stop the VM",
      description: "Stop the configured Crucible VM through the lifecycle manager.",
      inputSchema: VmStopInput.shape,
    },
    () => wrap(() => vm!.stop()),
  );
}

function registerNetworkTools(
  server: McpServer,
  config: CrucibleConfig,
  mode: NetworkMode,
  auditLogPath: string | undefined,
): void {
  const current = () =>
    buildNetworkPlan({
      config: { ...config.network, mode },
      vmName: config.vm.name,
      networkDevice: config.virtio.networkDevice,
    });

  server.registerTool(
    "network_status",
    {
      title: "Network status",
      description:
        "Report the configured Crucible network mode and whether mode changes can be applied live.",
      inputSchema: NetworkStatusInput.shape,
    },
    () => toJsonContent({ ok: true, result: buildNetworkRuntimeStatus(current()), auditLogPath }),
  );

  server.registerTool(
    "network_set_mode",
    {
      title: "Plan network mode change",
      description:
        "Plan a network mode switch and report whether the current QEMU backend requires restart.",
      inputSchema: NetworkSetModeInput.shape,
    },
    (input: NetworkSetModeInputType) => {
      const requested = buildNetworkPlan({
        config: { ...config.network, mode: input.mode },
        vmName: config.vm.name,
        networkDevice: config.virtio.networkDevice,
      });
      return toJsonContent({
        ok: true,
        result: buildNetworkModeChangePlan({ current: current(), requested }),
        auditLogPath,
      });
    },
  );

  server.registerTool(
    "network_active_status",
    {
      title: "Active network status",
      description: "Compare configured network mode with persisted QEMU launch args.",
      inputSchema: NetworkActiveStatusInput.shape,
    },
    async () => {
      try {
        const statePath = path.join(config.artifacts.directory, "state", `${config.vm.name}.json`);
        const raw = await readFile(statePath, "utf8");
        const state = JSON.parse(raw) as { qemu?: { args?: string[] } };
        const args = state.qemu?.args ?? [];
        const active = inferActiveNetworkMode(args);
        const pcapPath = inferActivePcapPath(args);
        return toJsonContent({
          ok: true,
          result: {
            configuredMode: mode,
            activeMode: active.mode,
            activeBackend: active.backend,
            matchesConfiguredMode: active.mode === mode,
            pcapPath,
            statePath,
          },
          auditLogPath,
        });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyFileTransferError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "network_pcap_info",
    {
      title: "Capture pcap info",
      description: "Report configured or active capture pcap path and size.",
      inputSchema: NetworkPcapInfoInput.shape,
    },
    async () => {
      try {
        const configuredPath = config.network.pcapPath;
        const statePath = path.join(config.artifacts.directory, "state", `${config.vm.name}.json`);
        let activePath: string | undefined;
        try {
          const raw = await readFile(statePath, "utf8");
          const state = JSON.parse(raw) as { qemu?: { args?: string[] } };
          activePath = inferActivePcapPath(state.qemu?.args ?? []);
        } catch {
          activePath = undefined;
        }
        const pcapPath = activePath ?? configuredPath;
        const info = pcapPath === undefined ? undefined : await statIfExists(pcapPath);
        return toJsonContent({
          ok: true,
          result: {
            configuredPath,
            activePath,
            pcapPath,
            exists: info !== undefined,
            sizeBytes: info?.size,
            modifiedAt: info?.mtime.toISOString(),
          },
          auditLogPath,
        });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyFileTransferError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "tshark_summary",
    {
      title: "TShark pcap summary",
      description: "Run host-side tshark summaries for a pcap artifact when tshark is installed.",
      inputSchema: TsharkSummaryInput.shape,
    },
    async (input: TsharkSummaryInputType) => {
      try {
        const pcapPath =
          input.pcapPath ?? (await activePcapPath(config)) ?? config.network.pcapPath;
        if (pcapPath === undefined) {
          return validationError(
            "pcapPath is required when network.pcapPath is not configured",
            auditLogPath,
          );
        }
        const result = await summarizePcapWithTshark(pcapPath);
        return toJsonContent({ ok: true, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );
}

function registerSnapshotTools(
  server: McpServer,
  snapshot: CrucibleSnapshotAdapter | undefined,
  auditLogPath: string | undefined,
): void {
  server.registerTool(
    "snapshot_list",
    {
      title: "List snapshots",
      description: "Enumerate qcow2 snapshots tracked by Crucible for the configured VM.",
      inputSchema: SnapshotListInput.shape,
    },
    async () => {
      if (snapshot === undefined) {
        return toJsonContent({
          ok: false,
          error: {
            kind: "vm-offline" as const,
            message: "snapshot adapter is not configured",
            auditLogPath,
          },
        });
      }
      try {
        const result = await snapshot.list();
        return toJsonContent({ ok: true, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );
  server.registerTool(
    "snapshot_restore",
    {
      title: "Restore a snapshot",
      description: "Restore a named qcow2 snapshot before or after running a sample.",
      inputSchema: SnapshotRestoreInput.shape,
    },
    async (input: SnapshotRestoreInputType) => {
      if (snapshot === undefined) {
        return toJsonContent({
          ok: false,
          error: {
            kind: "vm-offline" as const,
            message: "snapshot adapter is not configured",
            auditLogPath,
          },
        });
      }
      try {
        const result = await snapshot.restore(input.snapshotName);
        return toJsonContent({ ok: true, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );
}

function registerDebuggerTools(
  server: McpServer,
  manager: DebuggerSessionManager | undefined,
  guestClientFactory: (() => Promise<GuestAgentClient>) | undefined,
  auditLogPath: string | undefined,
): void {
  const effective = manager;

  const guard = (
    handler: (mgr: DebuggerSessionManager) => Promise<ReturnType<typeof toJsonContent>>,
  ) => {
    return async () => {
      if (effective === undefined) {
        return toJsonContent({
          ok: false,
          error: {
            kind: "vm-offline" as const,
            message:
              "debugger manager is not configured; install the guest agent and wire CRUCIBLE_GUEST_BASE_URL et al.",
            auditLogPath,
          },
        });
      }
      return handler(effective);
    };
  };

  const requireDebugClient = async (): Promise<GuestAgentClient> => {
    if (guestClientFactory === undefined) {
      throw new CrucibleError(
        "QMP_CONNECTION_FAILED",
        "guest client is not configured; install the guest agent and wire CRUCIBLE_GUEST_BASE_URL et al.",
      );
    }
    return guestClientFactory();
  };

  server.registerTool(
    "debug_open",
    {
      title: "Open debugger session",
      description:
        'Open a CDB-backed debugger session against a guest process. mode="launch" requires `executable`, mode="attach" requires `pid`.',
      inputSchema: {
        mode: z.enum(["launch", "attach"]),
        executable: z.string().min(1).optional().describe("Required when mode=launch"),
        arguments: z
          .array(z.string())
          .max(64)
          .optional()
          .describe("Forwarded to the launched executable; ignored for attach"),
        pid: z.number().int().positive().optional().describe("Required when mode=attach"),
        symbolPath: z.string().optional(),
        arch: z.enum(["x86", "x64"]).optional(),
        debuggerArch: z.enum(["auto", "x86", "x64"]).optional(),
        initialCommands: z.array(z.string().min(1)).max(64).optional(),
      },
    },
    async (raw: unknown) => {
      const parsed = DebugOpenInput.safeParse(raw);
      if (!parsed.success) {
        return toJsonContent({
          ok: false,
          error: { kind: "validation" as const, message: parsed.error.message, auditLogPath },
        });
      }
      if (manager !== undefined) {
        return guard((mgr) =>
          Promise.resolve().then(() => {
            const spec: DebuggerSessionSpec = parsed.data;
            const session: DebuggerSession = mgr.open(spec);
            return toJsonContent({
              ok: true,
              result: { id: session.id, createdAt: session.createdAt, spec: session.spec },
              auditLogPath,
            });
          }),
        )();
      }
      try {
        const client = await requireDebugClient();
        const spec: DebuggerSessionSpec = parsed.data;
        const cdbExecutable = await resolveCdbExecutable(
          client,
          requestedDebuggerArch(parsed.data),
        );
        const cdbArgs = buildPersistentCdbArgs(spec);
        const opened = await client.debugOpen({ executable: cdbExecutable, arguments: cdbArgs });
        let initialOutputBase64 = "";
        if (parsed.data.initialCommands !== undefined && parsed.data.initialCommands.length > 0) {
          const initial = await client.debugCommand(
            opened.id,
            parsed.data.initialCommands.join("\r\n"),
            1_000,
          );
          initialOutputBase64 = initial.outputBase64 ?? "";
        }
        return toJsonContent({
          ok: true,
          result: {
            id: opened.id,
            pid: opened.pid,
            createdAt: opened.startedAt,
            logPath: opened.logPath,
            spec,
            cdbExecutable,
            state: "running",
            lastEvent: "opened",
            stdoutBase64: initialOutputBase64,
          },
          auditLogPath,
        });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "debug_command",
    {
      title: "Run a debugger command",
      description: "Execute one or more CDB commands inside an open debugger session.",
      inputSchema: DebugCommandInput.shape,
    },
    async (input: DebugCommandInputType) => {
      if (manager === undefined) {
        try {
          const client = await requireDebugClient();
          const result = await client.debugCommand(
            input.sessionId,
            input.commands.join("\r\n"),
            input.waitMs,
          );
          return toJsonContent({
            ok: true,
            result: {
              command: input.commands.join("; "),
              stdoutBase64: result.outputBase64 ?? "",
              stderrBase64: "",
              exitCode: result.exitCode,
              timedOut: !result.exited,
              truncated: result.truncated,
              durationMs: input.waitMs ?? 750,
              logPath: result.logPath,
              exited: result.exited,
              exitError: result.exitError,
            },
            auditLogPath,
          });
        } catch (error) {
          return toJsonContent({
            ok: false,
            error: toToolError(classifyError(error), error, auditLogPath),
          });
        }
      }
      return guard(async (mgr) => {
        try {
          const result = await mgr.command(input.sessionId, input.commands);
          return toJsonContent({ ok: true, result, auditLogPath });
        } catch (error) {
          return toJsonContent({
            ok: false,
            error: toToolError(classifyError(error), error, auditLogPath),
          });
        }
      })();
    },
  );

  server.registerTool(
    "debug_dump",
    {
      title: "Capture user-mode dump",
      description: "Capture a user-mode dump file for an open debugger session's target.",
      inputSchema: DebugDumpInput.shape,
    },
    async (input: DebugDumpInputType) => {
      if (manager === undefined) {
        const flag = input.minidump ? "" : "/ma ";
        const command = `.dump ${flag}${input.outputGuestPath}`;
        try {
          const client = await requireDebugClient();
          const result = await client.debugCommand(input.sessionId, command, 5_000);
          return toJsonContent({
            ok: true,
            result: {
              command,
              stdoutBase64: result.outputBase64 ?? "",
              stderrBase64: "",
              exitCode: result.exitCode,
              timedOut: !result.exited,
              truncated: result.truncated,
              durationMs: 5_000,
              logPath: result.logPath,
              exited: result.exited,
              exitError: result.exitError,
            },
            auditLogPath,
          });
        } catch (error) {
          return toJsonContent({
            ok: false,
            error: toToolError(classifyError(error), error, auditLogPath),
          });
        }
      }
      return guard(async (mgr) => {
        try {
          const result = await mgr.dump(input.sessionId, {
            outputGuestPath: input.outputGuestPath,
            minidump: input.minidump,
          });
          return toJsonContent({ ok: true, result, auditLogPath });
        } catch (error) {
          return toJsonContent({
            ok: false,
            error: toToolError(classifyError(error), error, auditLogPath),
          });
        }
      })();
    },
  );

  server.registerTool(
    "debug_run_script",
    {
      title: "Run debugger script",
      description: "Run a multi-line CDB script in a temporary persistent debugger session.",
      inputSchema: DebugRunScriptInput.shape,
    },
    async (input: DebugRunScriptInputType) => {
      try {
        const client = await requireDebugClient();
        const target = input.target;
        const cdbExecutable = await resolveCdbExecutable(client, requestedDebuggerArch(target));
        const cdbArgs = buildPersistentCdbArgs(target);
        const opened = await client.debugOpen({
          executable: cdbExecutable,
          arguments: cdbArgs,
          logPath: input.logPath,
        });
        try {
          if (target.initialCommands !== undefined && target.initialCommands.length > 0) {
            const initial = await client.debugCommand(
              opened.id,
              target.initialCommands.join("\r\n"),
              1_000,
            );
            if (initial.exited) {
              throw new Error(
                initial.exitError ?? "debugger exited while running initial commands",
              );
            }
          }
          const result = await client.debugCommand(
            opened.id,
            input.script,
            input.timeoutMs ?? 30_000,
          );
          return toJsonContent({
            ok: true,
            result: {
              command: input.script,
              exitCode: result.exitCode,
              timedOut: !result.exited,
              stdoutBase64: result.outputBase64 ?? "",
              stderrBase64: "",
              truncated: result.truncated,
              durationMs: input.timeoutMs ?? 30_000,
              logPath: result.logPath,
              exited: result.exited,
              exitError: result.exitError,
              createdFiles: [] as string[],
            },
            auditLogPath,
          });
        } finally {
          await client.debugClose(opened.id).catch(() => undefined);
        }
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "debug_close",
    {
      title: "Close debugger session",
      description: "Close an open debugger session and discard its transcript.",
      inputSchema: DebugCloseInput.shape,
    },
    async (input: DebugCloseInputType) => {
      if (manager === undefined) {
        try {
          const client = await requireDebugClient();
          const result = await client.debugClose(input.sessionId);
          return toJsonContent({ ok: true, result, auditLogPath });
        } catch (error) {
          return toJsonContent({
            ok: false,
            error: toToolError(classifyError(error), error, auditLogPath),
          });
        }
      }
      return guard((mgr) =>
        Promise.resolve().then(() => {
          mgr.close(input.sessionId);
          return toJsonContent({
            ok: true,
            result: { id: input.sessionId, closed: true },
            auditLogPath,
          });
        }),
      )();
    },
  );
}

function registerDumpTools(
  server: McpServer,
  guestClientFactory: (() => Promise<GuestAgentClient>) | undefined,
  auditLogPath: string | undefined,
): void {
  server.registerTool(
    "dump_process",
    {
      title: "Dump process without debugger",
      description:
        "Capture a user-mode process dump without attaching CDB. Uses ProcDump/ProcDump64 when installed in the guest.",
      inputSchema: DumpProcessInput.shape,
    },
    async (input: DumpProcessInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const outputGuestPath =
          input.outputGuestPath ??
          `C:\\ProgramData\\Crucible\\staging\\dumps\\process-${input.pid}-${Date.now()}.dmp`;
        const full =
          input.dumpType === undefined ? (input.full ?? true) : input.dumpType === "full";
        const method = input.method ?? "auto";
        const script = buildProcessDumpScript(
          input.pid,
          outputGuestPath,
          full,
          method,
          input.suspend ?? false,
        );
        const result = await client.exec({
          executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
          as: "admin",
          timeoutMs: 10 * 60 * 1000,
        });
        const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64")
          .toString("utf8")
          .trim();
        if (result.exitCode !== 0) {
          const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
            .toString("utf8")
            .trim();
          throw new Error(`process dump failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
        }
        return toJsonContent({
          ok: true,
          result: JSON.parse(stdout) as unknown,
          auditLogPath,
        });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );
}

function buildProcessDumpScript(
  pid: number,
  outputGuestPath: string,
  full: boolean,
  method: "auto" | "procdump" | "comsvcs" | "minidumpwritedump",
  suspend: boolean,
): string {
  const escapedOutput = outputGuestPath.replaceAll("'", "''");
  const dumpFlag = full ? "-ma" : "-mm";
  const methodLiteral = method.replaceAll("'", "''");
  return `$ErrorActionPreference='Stop'; $method='${methodLiteral}'; if($method -eq 'minidumpwritedump'){ throw 'minidumpwritedump requires a native guest helper and is not implemented yet' }; $out='${escapedOutput}'; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null; $suspended=$false; if($${suspend}){ try{ Suspend-Process -Id ${pid} -ErrorAction Stop; $suspended=$true }catch{ throw 'failed to suspend target process: '+$_.Exception.Message } }; try { $tool=$null; if($method -eq 'auto' -or $method -eq 'procdump'){ $tools=@('C:\\Tools\\Sysinternals\\procdump64.exe','C:\\Tools\\Sysinternals\\procdump.exe','procdump64.exe','procdump.exe'); $tool=$tools | Where-Object { if([System.IO.Path]::IsPathRooted($_)){ Test-Path -LiteralPath $_ } else { [bool](Get-Command $_ -ErrorAction SilentlyContinue) } } | Select-Object -First 1 }; if($tool){ $stdout=[IO.Path]::GetTempFileName(); $stderr=[IO.Path]::GetTempFileName(); try { $args=@('-accepteula','${dumpFlag}',${pid},$out); $p=Start-Process -FilePath $tool -ArgumentList $args -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr; if($p.ExitCode -ne 0 -and -not (Test-Path -LiteralPath $out)){ $errText=((Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue),(Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue) -join ' ').Trim(); throw "ProcDump exited $($p.ExitCode): $errText" }; if(-not (Test-Path -LiteralPath $out)){ $candidate=Get-ChildItem -LiteralPath (Split-Path -Parent $out) -Filter (([IO.Path]::GetFileNameWithoutExtension($out))+'*.dmp') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if($candidate){ $out=$candidate.FullName } } } finally { Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue } } elseif($method -eq 'auto' -or $method -eq 'comsvcs') { if(-not $${full}){ throw 'comsvcs dump method only supports full dumps; use procdump for mini dumps' }; $dll=Join-Path $env:windir 'System32\\comsvcs.dll'; $entry="$dll,MiniDump"; & rundll32.exe $entry ${pid} $out full; $tool='comsvcs.dll'; if(-not (Test-Path -LiteralPath $out)){ throw 'comsvcs MiniDump did not create output file' }; if((Get-Item -LiteralPath $out).Length -le 0){ throw 'comsvcs MiniDump created an empty output file' } } else { throw 'ProcDump is not installed or not on PATH' }; $item=Get-Item -LiteralPath $out; $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $out).Hash.ToLowerInvariant(); [ordered]@{pid=${pid}; outputGuestPath=$out; full=$${full}; method=$method; sizeBytes=$item.Length; sha256=$hash; tool=$tool; suspended=$suspended} | ConvertTo-Json -Compress } finally { if($suspended){ Resume-Process -Id ${pid} -ErrorAction SilentlyContinue } }`;
}

function registerMonitorTools(
  server: McpServer,
  guestClientFactory: (() => Promise<GuestAgentClient>) | undefined,
  auditLogPath: string | undefined,
): void {
  server.registerTool(
    "process_monitor_start",
    {
      title: "Start process monitor",
      description: "Start ProcMon capture when ProcMon/Procmon64 is installed in the guest.",
      inputSchema: ProcessMonitorStartInput.shape,
    },
    async (input: ProcessMonitorStartInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const monitorId = `mon-${Date.now().toString(36)}`;
        const script = buildProcMonStartScript(monitorId, input.targetPid);
        const result = await client.exec({
          executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
          as: "admin",
          timeoutMs: 60_000,
        });
        const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64")
          .toString("utf8")
          .trim();
        if (result.exitCode !== 0) {
          const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
            .toString("utf8")
            .trim();
          throw new Error(stderr || stdout || `ProcMon start failed with exit ${result.exitCode}`);
        }
        return toJsonContent({ ok: true, result: JSON.parse(stdout) as unknown, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "process_monitor_stop",
    {
      title: "Stop process monitor",
      description: "Stop ProcMon capture and convert the PML artifact to CSV for summary.",
      inputSchema: ProcessMonitorStopInput.shape,
    },
    async (input: ProcessMonitorStopInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const script = buildProcMonStopScript(input.monitorId);
        const result = await client.exec({
          executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
          as: "admin",
          timeoutMs: 120_000,
        });
        const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64")
          .toString("utf8")
          .trim();
        if (result.exitCode !== 0) {
          const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
            .toString("utf8")
            .trim();
          throw new Error(stderr || stdout || `ProcMon stop failed with exit ${result.exitCode}`);
        }
        return toJsonContent({ ok: true, result: JSON.parse(stdout) as unknown, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );
}

function buildProcMonStartScript(monitorId: string, targetPid?: number): string {
  const escapedMonitorId = monitorId.replaceAll("'", "''");
  const targetPidValue = targetPid === undefined ? "$null" : String(targetPid);
  return `$ErrorActionPreference='Stop'; $tools=@('C:\\Tools\\Sysinternals\\Procmon64.exe','C:\\Tools\\Sysinternals\\Procmon.exe','Procmon64.exe','Procmon.exe'); $tool=$tools | Where-Object { if([System.IO.Path]::IsPathRooted($_)){ Test-Path -LiteralPath $_ } else { [bool](Get-Command $_ -ErrorAction SilentlyContinue) } } | Select-Object -First 1; if(-not $tool){ throw 'ProcMon is not installed or not on PATH' }; if(Get-Process -Name Procmon,Procmon64 -ErrorAction SilentlyContinue){ throw 'ProcMon is already running; stop the active capture before starting another' }; $root='C:\\ProgramData\\Crucible\\staging\\monitor'; New-Item -ItemType Directory -Force -Path $root | Out-Null; $out=Join-Path $root '${escapedMonitorId}.pml'; $args=@('/AcceptEula','/Quiet','/BackingFile',$out); Start-Process -FilePath $tool -ArgumentList $args -WindowStyle Hidden; Start-Sleep -Seconds 2; [ordered]@{monitorId='${escapedMonitorId}'; outputGuestPath=$out; tool=$tool; targetPid=${targetPidValue}; note='ProcMon capture is global; targetPid is used during stop-time summary filtering only'} | ConvertTo-Json -Compress`;
}

function buildProcMonStopScript(monitorId: string): string {
  const escapedMonitorId = monitorId.replaceAll("'", "''");
  return `$ErrorActionPreference='Stop'; $tools=@('C:\\Tools\\Sysinternals\\Procmon64.exe','C:\\Tools\\Sysinternals\\Procmon.exe','Procmon64.exe','Procmon.exe'); $tool=$tools | Where-Object { if([System.IO.Path]::IsPathRooted($_)){ Test-Path -LiteralPath $_ } else { [bool](Get-Command $_ -ErrorAction SilentlyContinue) } } | Select-Object -First 1; if(-not $tool){ throw 'ProcMon is not installed or not on PATH' }; & $tool /Terminate | Out-Null; Start-Sleep -Seconds 2; $root='C:\\ProgramData\\Crucible\\staging\\monitor'; $pml=Get-ChildItem -LiteralPath $root -Filter '${escapedMonitorId}.pml' -ErrorAction SilentlyContinue | Select-Object -First 1; if(-not $pml){ throw 'ProcMon backing file not found for monitor ${escapedMonitorId}' }; $csv=[IO.Path]::ChangeExtension($pml.FullName,'.csv'); & $tool /OpenLog $pml.FullName /SaveAs $csv | Out-Null; $events=0; $summary=[ordered]@{processCreates=0; fileWrites=0; registrySets=0; networkConnects=0}; if(Test-Path -LiteralPath $csv){ $rows=Import-Csv -LiteralPath $csv; $events=@($rows).Count; foreach($r in $rows){ $op=[string]$r.Operation; if($op -match 'Process Create'){ $summary.processCreates++ } elseif($op -match '^WriteFile$|SetRenameInformationFile|SetDispositionInformationFile'){ $summary.fileWrites++ } elseif($op -match 'RegSetValue'){ $summary.registrySets++ } elseif($op -match 'TCP|UDP'){ $summary.networkConnects++ } } }; [ordered]@{monitorId='${escapedMonitorId}'; events=$events; outputGuestPath=$pml.FullName; csvGuestPath=$csv; summary=$summary; note='ProcMon capture is global; concurrent monitor sessions are intentionally rejected at start'} | ConvertTo-Json -Compress -Depth 4`;
}

function registerMemoryTools(
  server: McpServer,
  guestClientFactory: (() => Promise<GuestAgentClient>) | undefined,
  auditLogPath: string | undefined,
): void {
  server.registerTool(
    "memory_scan",
    {
      title: "Scan process memory",
      description: "Scan process memory for ASCII or hex byte patterns without attaching CDB.",
      inputSchema: MemoryScanInput.shape,
    },
    async (input: MemoryScanInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const script = buildMemoryScanScript(input);
        const result = await client.exec({
          executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
          as: "admin",
          timeoutMs: 120_000,
        });
        const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64")
          .toString("utf8")
          .trim();
        if (result.exitCode !== 0) {
          const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
            .toString("utf8")
            .trim();
          throw new Error(stderr || stdout || `memory scan failed with exit ${result.exitCode}`);
        }
        if (stdout === "") {
          const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
            .toString("utf8")
            .trim();
          throw new Error(stderr || "memory scan produced no JSON output");
        }
        return toJsonContent({ ok: true, result: JSON.parse(stdout) as unknown, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );

  server.registerTool(
    "memory_dump_region",
    {
      title: "Dump process memory region",
      description: "Dump a process memory region to a guest file without attaching CDB.",
      inputSchema: MemoryDumpRegionInput.shape,
    },
    async (input: MemoryDumpRegionInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const script = buildMemoryDumpRegionScript(input);
        const result = await client.exec({
          executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
          as: "admin",
          timeoutMs: 120_000,
        });
        const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64")
          .toString("utf8")
          .trim();
        if (result.exitCode !== 0) {
          const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
            .toString("utf8")
            .trim();
          throw new Error(
            stderr || stdout || `memory region dump failed with exit ${result.exitCode}`,
          );
        }
        if (stdout === "") {
          const stderr = Buffer.from(result.stderrBase64 ?? "", "base64")
            .toString("utf8")
            .trim();
          throw new Error(stderr || "memory region dump produced no JSON output");
        }
        return toJsonContent({ ok: true, result: JSON.parse(stdout) as unknown, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError(classifyError(error), error, auditLogPath),
        });
      }
    },
  );
}

function buildMemoryScanScript(input: MemoryScanInputType): string {
  const payload = JSON.stringify({
    pid: input.pid,
    patterns: input.patterns,
    regions: input.regions ?? "all",
    maxMatches: input.maxMatches ?? 100,
  }).replaceAll("'", "''");
  return (
    memoryHelperPreamble() +
    `; $req='${payload}' | ConvertFrom-Json; $scanResult=[CrucibleMemory]::Scan([int]$req.pid, [string[]]$req.patterns, [string]$req.regions, [int]$req.maxMatches); $scanResult | ConvertTo-Json -Compress -Depth 6`
  );
}

function buildMemoryDumpRegionScript(input: MemoryDumpRegionInputType): string {
  const payload = JSON.stringify(input).replaceAll("'", "''");
  return (
    memoryHelperPreamble() +
    `; $req='${payload}' | ConvertFrom-Json; $dumpResult=[CrucibleMemory]::DumpRegion([int]$req.pid, [string]$req.baseAddress, [int64]$req.size, [string]$req.outputGuestPath); $dumpResult | ConvertTo-Json -Compress -Depth 4`
  );
}

function memoryHelperPreamble(): string {
  return `$ErrorActionPreference='Stop'; if(-not ('CrucibleMemory' -as [type])){ Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public class CrucibleMemory {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buffer, UIntPtr size, out UIntPtr read);
  [DllImport("kernel32.dll")] static extern UIntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION64 mbi, UIntPtr len);
  [StructLayout(LayoutKind.Sequential)] public struct MEMORY_BASIC_INFORMATION64 { public UInt64 BaseAddress; public UInt64 AllocationBase; public UInt32 AllocationProtect; public UInt32 __alignment1; public UInt64 RegionSize; public UInt32 State; public UInt32 Protect; public UInt32 Type; public UInt32 __alignment2; }
  const UInt32 PROCESS_QUERY_INFORMATION=0x0400, PROCESS_VM_READ=0x0010, MEM_COMMIT=0x1000, MEM_PRIVATE=0x20000, MEM_MAPPED=0x40000, MEM_IMAGE=0x1000000;
  public static object Scan(int pid, string[] patterns, string regions, int maxMatches) { var h=OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ,false,(UInt32)pid); if(h==IntPtr.Zero) throw new Exception("OpenProcess failed"); var matches=new List<object>(); try { UInt64 addr=0; while(matches.Count<maxMatches && addr<0x0000800000000000UL) { MEMORY_BASIC_INFORMATION64 mbi; var q=VirtualQueryEx(h,(IntPtr)addr,out mbi,(UIntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION64))); if(q==UIntPtr.Zero) break; if(mbi.State==MEM_COMMIT && RegionMatches(mbi.Type,regions) && IsReadable(mbi.Protect)) { int size=(int)Math.Min(mbi.RegionSize, 16*1024*1024); var buf=new byte[size]; UIntPtr read; if(ReadProcessMemory(h,(IntPtr)mbi.BaseAddress,buf,(UIntPtr)buf.Length,out read)) { int len=(int)read; foreach(var pat in patterns) { var needle=PatternBytes(pat); var idx=IndexOf(buf,len,needle); if(idx>=0) matches.Add(new { pattern=pat, address=$"0x{(mbi.BaseAddress+(UInt64)idx):x}", regionBase=$"0x{mbi.BaseAddress:x}", regionSize=mbi.RegionSize, protection=$"0x{mbi.Protect:x}", previewHex=Hex(buf,idx,Math.Min(32,len-idx)) }); if(matches.Count>=maxMatches) break; } } } addr=mbi.BaseAddress+Math.Max(mbi.RegionSize,0x1000); } return new { pid=pid, matches=matches }; } finally { CloseHandle(h); } }
  public static object DumpRegion(int pid, string baseAddress, long size, string outputGuestPath) { UInt64 b=Convert.ToUInt64(baseAddress.Replace("0x",""),16); var h=OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ,false,(UInt32)pid); if(h==IntPtr.Zero) throw new Exception("OpenProcess failed"); try { Directory.CreateDirectory(Path.GetDirectoryName(outputGuestPath)); if(size>Int32.MaxValue) throw new Exception("region size too large"); var buf=new byte[(int)size]; UIntPtr read; if(!ReadProcessMemory(h,(IntPtr)b,buf,(UIntPtr)buf.Length,out read)) throw new Exception("ReadProcessMemory failed"); string hash; using(var sha=SHA256.Create()){ using(var fs=File.Open(outputGuestPath,FileMode.Create,FileAccess.Write)){ fs.Write(buf,0,(int)read); var written=new byte[(int)read]; Buffer.BlockCopy(buf,0,written,0,(int)read); hash=BitConverter.ToString(sha.ComputeHash(written)).Replace("-","").ToLowerInvariant(); } } return new { outputGuestPath=outputGuestPath, sizeBytes=(int)read, sha256=hash }; } finally { CloseHandle(h); } }
  static bool RegionMatches(UInt32 type,string regions){ return regions=="all" || (regions=="private"&&type==MEM_PRIVATE) || (regions=="mapped"&&type==MEM_MAPPED) || (regions=="image"&&type==MEM_IMAGE); }
  static bool IsReadable(UInt32 p){ return (p&0x100)==0 && (p&0x01)==0; }
  static byte[] PatternBytes(string p){ if(p.StartsWith("ascii:",StringComparison.OrdinalIgnoreCase)) return Encoding.ASCII.GetBytes(p.Substring(6)); bool hex=p.Length%2==0; foreach(char c in p){ if(!Uri.IsHexDigit(c)){ hex=false; break; } } if(hex){ var b=new byte[p.Length/2]; for(int i=0;i<b.Length;i++) b[i]=Convert.ToByte(p.Substring(i*2,2),16); return b; } return Encoding.ASCII.GetBytes(p); }
  static int IndexOf(byte[] b,int len,byte[] n){ if(n.Length==0||n.Length>len) return -1; for(int i=0;i<=len-n.Length;i++){ int j=0; for(;j<n.Length;j++) if(b[i+j]!=n[j]) break; if(j==n.Length) return i; } return -1; }
  static string Hex(byte[] b,int off,int len){ var sb=new StringBuilder(); for(int i=0;i<len;i++) sb.Append(b[off+i].ToString("x2")); return sb.ToString(); }
}
'@ }`;
}

const DEFAULT_CDB_EXECUTABLE = "C:\\Program Files\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe";

async function resolveCdbExecutable(
  client: GuestAgentClient,
  arch: "auto" | "x86" | "x64" | undefined,
): Promise<string> {
  if (arch === undefined || arch === "auto") {
    const health = await client.health();
    return health.cdbPath ?? DEFAULT_CDB_EXECUTABLE;
  }
  return defaultCdbPathForArch(arch);
}

function requestedDebuggerArch(input: {
  readonly arch?: "x86" | "x64";
  readonly debuggerArch?: "auto" | "x86" | "x64";
}): "auto" | "x86" | "x64" | undefined {
  return input.debuggerArch ?? input.arch;
}

function defaultCdbPathForArch(arch: "x86" | "x64"): string {
  const suffix = arch === "x86" ? "x86" : "x64";
  return `C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\${suffix}\\cdb.exe`;
}

function buildPersistentCdbArgs(spec: DebuggerSessionSpec): readonly string[] {
  const args: string[] = [];
  if (spec.symbolPath !== undefined && spec.symbolPath !== "") {
    args.push("-y", spec.symbolPath);
  }
  if (spec.mode === "launch") {
    args.push(spec.executable, ...(spec.arguments ?? []));
  } else {
    args.push("-p", String(spec.pid));
  }
  return args;
}

/** Build a GuestAgentClient by reading the standard PEM file paths. */
export async function buildGuestAgentClientFromFiles(
  options: { readonly baseUrl: string } & {
    readonly caPath: string;
    readonly clientCertificatePath: string;
    readonly clientPrivateKeyPath: string;
    readonly timeoutMs?: number;
    readonly maxBodyBytes?: number;
  },
): Promise<GuestAgentClient> {
  const [caPem, clientCertPem, clientKeyPem] = await Promise.all([
    readFile(options.caPath, "utf8"),
    readFile(options.clientCertificatePath, "utf8"),
    readFile(options.clientPrivateKeyPath, "utf8"),
  ]);
  const clientOptions: GuestAgentClientOptions = {
    baseUrl: options.baseUrl,
    caPem,
    clientCertificatePem: clientCertPem,
    clientPrivateKeyPem: clientKeyPem,
    timeoutMs: options.timeoutMs,
    maxBodyBytes: options.maxBodyBytes,
  };
  return new GuestAgentClient(clientOptions);
}

/**
 * Wrap a single-shot factory so the resulting GuestAgentClient is built lazily
 * and reused for the process lifetime. Long-running MCP servers should pass
 * the cached factory to registerCrucibleTools so undici keep-alive sockets
 * and PEM file reads aren't repeated per request.
 */
export function cacheGuestClientFactory(
  factory: () => Promise<GuestAgentClient>,
): () => Promise<GuestAgentClient> {
  let cached: Promise<GuestAgentClient> | undefined;
  return () => {
    if (cached === undefined) {
      cached = factory();
    }
    return cached;
  };
}

/** Run the MCP server over stdio (entrypoint for `crucible mcp`). */
export async function runStdioMcpServer(
  options: Pick<
    RegisterCrucibleToolsOptions,
    | "guestClientFactory"
    | "hostCheck"
    | "vmAdapter"
    | "snapshotAdapter"
    | "debuggerManager"
    | "auditLogPath"
    | "config"
    | "networkMode"
    | "policy"
  >,
): Promise<void> {
  const server = createCrucibleMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function createCrucibleMcpServer(
  options: Pick<
    RegisterCrucibleToolsOptions,
    | "guestClientFactory"
    | "hostCheck"
    | "vmAdapter"
    | "snapshotAdapter"
    | "debuggerManager"
    | "auditLogPath"
    | "config"
    | "networkMode"
    | "policy"
  >,
): McpServer {
  const server = new McpServer({ name: "crucible", version: CRUCIBLE_VERSION });
  registerCrucibleTools({ server, ...options });
  return server;
}

async function requireGuestClient(
  factory?: () => Promise<GuestAgentClient>,
): Promise<GuestAgentClient> {
  if (factory === undefined) {
    throw new CrucibleError(
      "STATE_INVALID",
      "guest client is not configured; provision the VM and install the guest agent first",
    );
  }
  return factory();
}

function classifyError(error: unknown): CrucibleToolErrorKind {
  if (error instanceof CrucibleError) {
    switch (error.code) {
      case "CONFIG_INVALID":
        return "validation";
      case "HOST_PREREQUISITE_MISSING":
        return "host-prerequisite";
      case "QMP_DISCONNECTED":
      case "QMP_CONNECTION_FAILED":
        return "vm-offline";
      case "QMP_TIMEOUT":
      case "PROCESS_TIMEOUT":
        return "timeout";
      default:
        return "guest-failed";
    }
  }
  if (error instanceof Error && /denied|forbidden|policy/i.test(error.message)) {
    return "policy-denied";
  }
  return "internal";
}

function classifyFileTransferError(error: unknown): CrucibleToolErrorKind {
  if (isFsInputError(error)) {
    return "validation";
  }
  return classifyError(error);
}

function isFsInputError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "EACCES", "EISDIR", "ENOTDIR", "EEXIST", "EPERM"].includes(String(error.code))
  );
}

function validationError(message: string, auditLogPath: string | undefined) {
  return toJsonContent({
    ok: false,
    error: { kind: "validation" as const, message, auditLogPath },
  });
}

function inferActiveNetworkMode(args: readonly string[]): {
  readonly mode: NetworkMode;
  readonly backend: "user" | "tap" | "none";
} {
  const netdevArgs = args.filter((arg) => arg.startsWith("user,") || arg.startsWith("tap,"));
  if (netdevArgs.some((arg) => arg.startsWith("tap,"))) {
    return { mode: "capture", backend: "tap" };
  }
  const user = netdevArgs.find((arg) => arg.startsWith("user,"));
  if (user === undefined) {
    return { mode: "isolated", backend: "none" };
  }
  return user.includes("restrict=off")
    ? { mode: "nat", backend: "user" }
    : { mode: "isolated", backend: "user" };
}

function inferActivePcapPath(args: readonly string[]): string | undefined {
  const filter = args.find((arg) => arg.startsWith("filter-dump,"));
  if (filter === undefined) return undefined;
  const file = filter
    .split(",")
    .find((part) => part.startsWith("file="))
    ?.slice("file=".length);
  return file === "" ? undefined : file;
}

async function statIfExists(filePath: string) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

async function activePcapPath(config: CrucibleConfig): Promise<string | undefined> {
  try {
    const statePath = path.join(config.artifacts.directory, "state", `${config.vm.name}.json`);
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw) as { qemu?: { args?: string[] } };
    return inferActivePcapPath(state.qemu?.args ?? []);
  } catch {
    return undefined;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && String(error.code) === "ENOENT";
}

async function summarizePcapWithTshark(pcapPath: string): Promise<{
  readonly pcapPath: string;
  readonly tsharkAvailable: boolean;
  readonly sizeBytes: number;
  readonly conversations: string;
  readonly dnsQueries: readonly string[];
  readonly httpHosts: readonly string[];
  readonly tlsSni: readonly string[];
}> {
  await access(pcapPath);
  const info = await stat(pcapPath);
  const conversations = await runTshark(["-r", pcapPath, "-q", "-z", "conv,tcp", "-z", "conv,udp"]);
  const dnsQueries = uniqueNonEmptyLines(
    await runTshark(["-r", pcapPath, "-Y", "dns.qry.name", "-T", "fields", "-e", "dns.qry.name"]),
  );
  const httpHosts = uniqueNonEmptyLines(
    await runTshark(["-r", pcapPath, "-Y", "http.host", "-T", "fields", "-e", "http.host"]),
  );
  const tlsSni = uniqueNonEmptyLines(
    await runTshark([
      "-r",
      pcapPath,
      "-Y",
      "tls.handshake.extensions_server_name",
      "-T",
      "fields",
      "-e",
      "tls.handshake.extensions_server_name",
    ]),
  );
  return {
    pcapPath,
    tsharkAvailable: true,
    sizeBytes: info.size,
    conversations,
    dnsQueries,
    httpHosts,
    tlsSni,
  };
}

function runTshark(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tshark", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const cap = 512 * 1024;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= cap) return;
      const slice = chunk.subarray(0, cap - stdoutBytes);
      stdout.push(slice);
      stdoutBytes += slice.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= cap) return;
      const slice = chunk.subarray(0, cap - stderrBytes);
      stderr.push(slice);
      stderrBytes += slice.byteLength;
    });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("tshark is not installed or not on PATH"));
        return;
      }
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(`tshark exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

function uniqueNonEmptyLines(text: string): readonly string[] {
  return Array.from(
    new Set(
      text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  );
}

type GuestFileInlinePreview = GuestAgentFileInspection & {
  readonly inline: true;
  readonly encoding: "ascii";
  readonly contents: string;
};

type GuestFileMetadataPreview = GuestAgentFileInspection & {
  readonly inline: false;
  readonly reason: "non-ascii";
};

const INLINE_READ_LIMIT_BYTES = 64 * 1024;
function summarizeGuestFile(
  buffer: Buffer,
  inspection: GuestAgentFileInspection,
): GuestFileInlinePreview | GuestFileMetadataPreview {
  if (!isSafeAscii(buffer)) {
    return {
      ...inspection,
      inline: false,
      reason: "non-ascii",
    };
  }
  return { ...inspection, inline: true, encoding: "ascii", contents: buffer.toString("ascii") };
}

function isSafeAscii(buffer: Buffer): boolean {
  return buffer.every(
    (byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e),
  );
}

function toToolError(
  kind: CrucibleToolErrorKind,
  error: unknown,
  auditLogPath?: string,
): CrucibleToolError {
  const message = error instanceof Error ? error.message : String(error);
  return { kind, message, auditLogPath };
}

function toJsonContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
