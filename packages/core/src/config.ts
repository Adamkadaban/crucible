import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";

import { DEFAULT_MEDIA_CACHE_DIR } from "./media.js";

const mediaOverrideSchema = z
  .object({
    path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine((value) => value.path !== undefined || value.url !== undefined, {
    message: "media override must include path or url",
  });

const socketPathSchema = z.string().min(1);

const vmConfigSchema = z
  .object({
    name: z.string().min(1).default("crucible-win11"),
    cpus: z.number().int().min(1).default(4),
    memoryMiB: z.number().int().min(2048).default(8192),
    diskGiB: z.number().int().min(40).default(128),
    extraQemuArgs: z.array(z.string()).default([]),
  })
  .strict();

const mediaConfigSchema = z
  .object({
    cacheDir: z.string().min(1).default(DEFAULT_MEDIA_CACHE_DIR),
    profile: z
      .enum(["windows11-enterprise-eval", "windows-server-2025-eval"])
      .default("windows11-enterprise-eval"),
    windowsIso: mediaOverrideSchema.optional(),
    virtioIso: mediaOverrideSchema.optional(),
    virtioGuestTools: mediaOverrideSchema.optional(),
  })
  .strict();

const virtioConfigSchema = z
  .object({
    diskBus: z.enum(["virtio-blk", "virtio-scsi"]).default("virtio-scsi"),
    networkDevice: z.enum(["virtio-net-pci"]).default("virtio-net-pci"),
    balloon: z.boolean().default(true),
    rng: z.boolean().default(true),
  })
  .strict();

const networkConfigSchema = z
  .object({
    mode: z.enum(["isolated", "nat", "capture"]).default("isolated"),
    controlPort: z.number().int().min(1).max(65535).default(8443),
  })
  .strict();

const qmpConfigSchema = z
  .object({
    socketPath: socketPathSchema.default("artifacts/qmp.sock"),
    timeoutMs: z.number().int().min(100).default(5000),
  })
  .strict();

const qgaConfigSchema = z
  .object({
    socketPath: socketPathSchema.default("artifacts/qga.sock"),
    timeoutMs: z.number().int().min(100).default(10000),
  })
  .strict();

const artifactsConfigSchema = z
  .object({
    directory: z.string().min(1).default("artifacts"),
    manifestPath: z.string().min(1).default("artifacts/manifest.json"),
    logsDirectory: z.string().min(1).default("artifacts/logs"),
    snapshotsDirectory: z.string().min(1).default("snapshots"),
    secretsDirectory: z.string().min(1).default("secrets"),
  })
  .strict();

export const crucibleConfigSchema = z
  .object({
    vm: z.preprocess((value) => value ?? {}, vmConfigSchema),
    media: z.preprocess((value) => value ?? {}, mediaConfigSchema),
    virtio: z.preprocess((value) => value ?? {}, virtioConfigSchema),
    network: z.preprocess((value) => value ?? {}, networkConfigSchema),
    qmp: z.preprocess((value) => value ?? {}, qmpConfigSchema),
    qga: z.preprocess((value) => value ?? {}, qgaConfigSchema),
    artifacts: z.preprocess((value) => value ?? {}, artifactsConfigSchema),
  })
  .strict();

export type CrucibleConfig = z.output<typeof crucibleConfigSchema>;
export type CrucibleConfigInput = z.input<typeof crucibleConfigSchema>;

export function parseCrucibleConfig(input: unknown): CrucibleConfig {
  return crucibleConfigSchema.parse(input);
}

export function loadCrucibleConfigFile(filePath = "crucible.config.json"): CrucibleConfig {
  if (!existsSync(filePath)) {
    return defaultCrucibleConfig;
  }

  return parseCrucibleConfig(JSON.parse(readFileSync(filePath, "utf8")));
}

export const defaultCrucibleConfig = parseCrucibleConfig({});
