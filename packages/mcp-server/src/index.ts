import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  CRUCIBLE_VERSION,
  CrucibleError,
  DebuggerSessionManager,
  type DebuggerSession,
  type DebuggerSessionSpec,
  GuestAgentClient,
  type GuestAgentClientOptions,
  type GuestAgentExecRequest,
  type GuestAgentExecResult,
  type GuestAgentHealth,
  type GuestAgentUploadResult,
  type HostCheckProbeResult,
  type RunResult,
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
    description: "Start the configured Crucible VM through the injected lifecycle manager.",
  },
  {
    name: "vm_stop",
    description: "Stop the configured Crucible VM through the injected lifecycle manager.",
  },
  {
    name: "snapshot_list",
    description: "List qcow2 snapshots tracked by Crucible for the configured VM.",
  },
  {
    name: "snapshot_restore",
    description: "Restore a named snapshot before or after running a sample.",
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
    name: "guest_upload",
    description:
      "Upload a host file into the guest staging directory through the Crucible guest agent.",
  },
  {
    name: "guest_download",
    description:
      "Download a file from the guest staging directory back to the host via the Crucible guest agent.",
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

const Base64String = z
  .string()
  .min(1)
  .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0, {
    message: "must be a canonical base64 string",
  });

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

const GuestUploadInput = z
  .object({
    targetPath: z.string().min(1),
    contentsBase64: Base64String,
  })
  .strict();
type GuestUploadInputType = z.infer<typeof GuestUploadInput>;

const GuestDownloadInput = z
  .object({
    sourcePath: z.string().min(1),
  })
  .strict();
type GuestDownloadInputType = z.infer<typeof GuestDownloadInput>;

const HostCheckInput = z.object({}).strict();
const GuestHealthInput = z.object({}).strict();
const VmStatusInput = z.object({}).strict();
const VmStartInput = z.object({}).strict();
const VmStopInput = z.object({}).strict();
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
    })
    .strict(),
  z
    .object({
      mode: z.literal("attach"),
      pid: z.number().int().positive(),
      symbolPath: z.string().optional(),
    })
    .strict(),
]);
type _DebugOpenInputType = z.infer<typeof DebugOpenInput>;

const DebugCommandInput = z
  .object({
    sessionId: z.string().min(1),
    commands: z.array(z.string().min(1)).min(1).max(32),
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
  registerSnapshotTools(server, snapshotAdapter, auditLogPath);
  registerDebuggerTools(server, options.debuggerManager, guestClientFactory, auditLogPath);

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
    "guest_upload",
    {
      title: "Upload to guest staging",
      description:
        "Write a base64-encoded payload into the guest staging directory. Mirrors POST /upload on the guest agent.",
      inputSchema: GuestUploadInput.shape,
    },
    async (input: GuestUploadInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const payload = Buffer.from(input.contentsBase64, "base64");
        const result: GuestAgentUploadResult = await client.upload(input.targetPath, payload);
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
    "guest_download",
    {
      title: "Download from guest staging",
      description:
        "Read a file from the guest staging directory and return it base64-encoded. Mirrors GET /download on the guest agent.",
      inputSchema: GuestDownloadInput.shape,
    },
    async (input: GuestDownloadInputType) => {
      try {
        const client = await requireGuestClient(guestClientFactory);
        const buffer = await client.download(input.sourcePath);
        return toJsonContent({
          ok: true,
          result: {
            sourcePath: input.sourcePath,
            sizeBytes: buffer.byteLength,
            contentsBase64: buffer.toString("base64"),
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
  // If no manager was injected but a guest client factory is, build a
  // default manager that issues cdb invocations through the guest agent's
  // /exec endpoint.
  const effective =
    manager ??
    (guestClientFactory === undefined
      ? undefined
      : new DebuggerSessionManager({
          run: async (args) => {
            const client = await guestClientFactory();
            const result = await client.exec({
              executable: "cdb.exe",
              arguments: [...args],
              timeoutMs: 5 * 60 * 1000,
            });
            return {
              stdoutBase64: result.stdoutBase64 ?? "",
              stderrBase64: result.stderrBase64 ?? "",
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              truncated: result.truncated,
              durationMs: result.durationMs,
            } satisfies RunResult;
          },
        }));

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
    "debug_close",
    {
      title: "Close debugger session",
      description: "Close an open debugger session and discard its transcript.",
      inputSchema: DebugCloseInput.shape,
    },
    async (input: DebugCloseInputType) => {
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
