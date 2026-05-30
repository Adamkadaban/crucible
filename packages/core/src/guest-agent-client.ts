import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { Agent, fetch } from "undici";
import type { Dispatcher } from "undici";

/** Options accepted when constructing the guest agent client. */
export type GuestAgentClientOptions = {
  /** Full HTTPS URL of the agent, e.g. `https://192.0.2.2:8443`. */
  readonly baseUrl: string;
  /** PEM-encoded host CA the agent's server certificate chains to. */
  readonly caPem: string;
  /** PEM-encoded host client certificate presented to the agent. */
  readonly clientCertificatePem: string;
  /** PEM-encoded host client private key. */
  readonly clientPrivateKeyPem: string;
  /** Optional override for per-request timeout in ms. Default 30s. */
  readonly timeoutMs?: number;
  /** Optional override for the maximum buffered body size for exec/preview helpers. */
  readonly maxBodyBytes?: number;
};

export type GuestAgentHealth = {
  readonly status: string;
  readonly version: string;
  readonly hostName: string;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
  readonly goVersion: string;
  readonly windbgInstalled: boolean;
  readonly cdbPath?: string;
  readonly windbgPath?: string;
};

export type GuestAgentExecRequest = {
  readonly executable: string;
  readonly arguments?: readonly string[];
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly as?: "service" | "standard" | "admin";
};

export type GuestAgentExecResult = {
  readonly exitCode: number;
  readonly stdoutBase64?: string;
  readonly stderrBase64?: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly truncated: boolean;
};

export type GuestAgentTransferResult = {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
};

export type GuestAgentFileInspection = {
  readonly path: string;
  readonly sizeBytes: number;
  readonly headerHex: string;
  readonly headerAscii: string;
};

export type GuestAgentUploadResult = GuestAgentTransferResult;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY = 64 * 1024 * 1024;

/**
 * Host-side client that talks mTLS to a Crucible guest agent. Wraps undici's
 * fetch so the host certificate/key are pinned per-instance and the agent's
 * server certificate is verified against the supplied CA.
 */
export class GuestAgentClient {
  readonly #baseUrl: string;
  readonly #dispatcher: Dispatcher;
  readonly #timeoutMs: number;
  readonly #maxBodyBytes: number;

  constructor(options: GuestAgentClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
    this.#dispatcher = new Agent({
      connect: {
        ca: options.caPem,
        cert: options.clientCertificatePem,
        key: options.clientPrivateKeyPem,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
      },
    });
  }

  async health(): Promise<GuestAgentHealth> {
    const res = await this.#request("GET", "/health");
    return (await res.json()) as GuestAgentHealth;
  }

  async exec(request: GuestAgentExecRequest): Promise<GuestAgentExecResult> {
    const res = await this.#request("POST", "/exec", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return (await res.json()) as GuestAgentExecResult;
  }

  async upload(targetPath: string, contents: Buffer): Promise<GuestAgentUploadResult> {
    return this.#uploadStream(targetPath, Readable.from(contents));
  }

  async uploadFile(hostPath: string, guestPath: string): Promise<GuestAgentUploadResult> {
    return this.#uploadStream(guestPath, createReadStream(hostPath));
  }

  async download(sourcePath: string): Promise<Buffer> {
    const res = await this.#request("GET", `/download?path=${encodeURIComponent(sourcePath)}`);
    if (res.body === null) {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBodyBytes = this.#maxBodyBytes;
    await pipeline(Readable.fromWeb(res.body), async (source) => {
      for await (const chunk of source) {
        const buffer = Buffer.from(chunk as Uint8Array);
        total += buffer.byteLength;
        if (total > maxBodyBytes) {
          throw new Error(`download payload exceeded maxBodyBytes (${maxBodyBytes})`);
        }
        chunks.push(buffer);
      }
    });
    return Buffer.concat(chunks);
  }

  async downloadFile(guestPath: string, hostPath: string): Promise<GuestAgentTransferResult> {
    const res = await this.#request("GET", `/download?path=${encodeURIComponent(guestPath)}`);
    const sizeBytes = Number(res.headers.get("x-crucible-size") ?? 0);
    if (res.body === null) {
      throw new Error("guest agent returned an empty download body");
    }
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          const buffer = Buffer.from(chunk as Uint8Array);
          hash.update(buffer);
          yield buffer;
        }
      },
      createWriteStream(hostPath, { flags: "wx" }),
    );
    const sha256 = hash.digest("hex");
    return {
      path: guestPath,
      sizeBytes,
      sha256: res.headers.get("x-crucible-sha256") ?? sha256,
    };
  }

  async inspect(sourcePath: string): Promise<GuestAgentFileInspection> {
    const res = await this.#request("GET", `/inspect?path=${encodeURIComponent(sourcePath)}`);
    return (await res.json()) as GuestAgentFileInspection;
  }

  /**
   * Release the underlying undici Agent's keep-alive sockets. Long-running
   * hosts should call this when the client is no longer needed.
   */
  async close(): Promise<void> {
    await this.#dispatcher.close();
  }

  async #uploadStream(
    targetPath: string,
    source: NodeJS.ReadableStream,
  ): Promise<GuestAgentUploadResult> {
    const res = await this.#request("POST", `/upload?path=${encodeURIComponent(targetPath)}`, {
      headers: { "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" },
      body: source.pipe(createGzip()),
      duplex: "half",
    });
    return (await res.json()) as GuestAgentUploadResult;
  }

  async #request(
    method: string,
    path: string,
    init: {
      headers?: Record<string, string>;
      body?: Buffer | string | NodeJS.ReadableStream;
      duplex?: "half";
    } = {},
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      const res = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: init.headers,
        body: init.body as Dispatcher.DispatchOptions["body"],
        dispatcher: this.#dispatcher,
        signal: controller.signal,
        duplex: init.duplex,
      });
      if (!res.ok) {
        const errorPreview = await readBoundedText(res.body, 4 * 1024);
        throw new Error(`guest agent ${method} ${path} → ${res.status} ${errorPreview.trim()}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Drain at most `cap` bytes from a fetch body and return the UTF-8 decoding.
 * Used to bound how much memory we allocate when the agent returns an error
 * response body.
 */
async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const slice = value.subarray(0, Math.min(value.byteLength, cap - total));
      chunks.push(slice);
      total += slice.byteLength;
    }
  } catch {
    // ignore, return what we have
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const text = buf.toString("utf8");
  return text;
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
