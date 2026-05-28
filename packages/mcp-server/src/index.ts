import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  CRUCIBLE_VERSION,
  CrucibleError,
  GuestAgentClient,
  type GuestAgentClientOptions,
  type GuestAgentExecRequest,
  type GuestAgentExecResult,
  type GuestAgentHealth,
  type GuestAgentUploadResult,
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
    name: "guest_health",
    description: "Report guest service readiness once a VM has been provisioned.",
  },
  {
    name: "guest_exec",
    description: "Run a process inside the Windows guest via the Crucible guest agent.",
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
  })
  .strict();
type GuestExecInputType = z.infer<typeof GuestExecInput>;

const GuestUploadInput = z
  .object({
    targetPath: z.string().min(1),
    contentsBase64: z.string().min(1),
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

export type RegisterCrucibleToolsOptions = {
  readonly server: McpServer;
  readonly hostCheck?: () => Promise<HostCheckResult>;
  readonly guestClientFactory?: () => Promise<GuestAgentClient>;
  readonly auditLogPath?: string;
};

export type HostCheckResult = {
  readonly healthy: boolean;
  readonly missing: readonly string[];
  readonly notes?: string;
};

/**
 * Register the bootstrap MCP tools on the supplied server.
 *
 * Optional dependencies are injected so tests can drive the same handlers
 * without spawning QEMU. In production callers wire a real
 * GuestAgentClient and a host-prerequisite checker.
 */
export function registerCrucibleTools(options: RegisterCrucibleToolsOptions): void {
  const { server, hostCheck, guestClientFactory, auditLogPath } = options;

  server.registerTool(
    "host_check",
    {
      title: "Check host prerequisites",
      description:
        "Verify the Linux host has QEMU/KVM, OVMF, virtio drivers, and other binaries required to run a Crucible analysis VM.",
      inputSchema: HostCheckInput.shape,
    },
    async () => {
      try {
        const probe =
          hostCheck ??
          (() =>
            Promise.resolve({
              healthy: true,
              missing: [] as string[],
              notes: "default stub host_check",
            }));
        const result = await probe();
        return toJsonContent({ ok: result.healthy, result, auditLogPath });
      } catch (error) {
        return toJsonContent({
          ok: false,
          error: toToolError("host-prerequisite", error, auditLogPath),
        });
      }
    },
  );

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

/** Run the MCP server over stdio (entrypoint for `crucible mcp`). */
export async function runStdioMcpServer(
  options: Pick<RegisterCrucibleToolsOptions, "guestClientFactory" | "hostCheck" | "auditLogPath">,
): Promise<void> {
  const server = createCrucibleMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function createCrucibleMcpServer(
  options: Pick<RegisterCrucibleToolsOptions, "guestClientFactory" | "hostCheck" | "auditLogPath">,
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
      default:
        return "guest-failed";
    }
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
