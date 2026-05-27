import { readFileSync } from "node:fs";
import type { ZodType } from "zod";
import { ZodError, z } from "zod";

import { analysisVmPolicyConfigSchema } from "./analysis-policy.js";
import { CrucibleError } from "./errors.js";
import { DEFAULT_MEDIA_CACHE_DIR } from "./media.js";
import { networkConfigSchema } from "./network.js";

const isoPathSchema = z
  .string()
  .min(1)
  .regex(/\.iso$/i, {
    message: "media ISO override paths must end in .iso",
  });

const isoUrlSchema = z.url().regex(/\.iso(?:[?#].*)?$/i, {
  message: "media ISO override URLs must end in .iso",
});

const driverBundlePathSchema = z
  .string()
  .min(1)
  .regex(/\.(?:iso|exe|zip|msi)$/i, {
    message: "driver bundle override paths must end in .iso, .exe, .zip, or .msi",
  });

const driverBundleUrlSchema = z.url().regex(/\.(?:iso|exe|zip|msi)(?:[?#].*)?$/i, {
  message: "driver bundle override URLs must end in .iso, .exe, .zip, or .msi",
});

function mediaOverrideSchema(pathSchema: ZodType<string>, urlSchema: ZodType<string>) {
  return z
    .object({
      path: pathSchema.optional(),
      url: urlSchema.optional(),
      sha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional(),
    })
    .strict()
    .refine((value) => value.path !== undefined || value.url !== undefined, {
      message: "media override must include path or url",
    });
}

const isoOverrideSchema = mediaOverrideSchema(isoPathSchema, isoUrlSchema);
const driverBundleOverrideSchema = mediaOverrideSchema(
  driverBundlePathSchema,
  driverBundleUrlSchema,
);

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
    windowsIso: isoOverrideSchema.optional(),
    virtioIso: isoOverrideSchema.optional(),
    driverBundle: driverBundleOverrideSchema.optional(),
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
    $schema: z.string().optional(),
    vm: z.preprocess((value) => value ?? {}, vmConfigSchema),
    media: z.preprocess((value) => value ?? {}, mediaConfigSchema),
    virtio: z.preprocess((value) => value ?? {}, virtioConfigSchema),
    network: z.preprocess((value) => value ?? {}, networkConfigSchema),
    analysisPolicy: z.preprocess((value) => value ?? {}, analysisVmPolicyConfigSchema),
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
  try {
    return parseCrucibleConfig(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return defaultCrucibleConfig;
    }

    if (error instanceof SyntaxError || error instanceof ZodError) {
      throw new CrucibleError("CONFIG_INVALID", `Invalid Crucible config file: ${filePath}`, error);
    }

    throw new CrucibleError(
      "CONFIG_INVALID",
      `Unable to read Crucible config file: ${filePath}`,
      error,
    );
  }
}

export const defaultCrucibleConfig = parseCrucibleConfig({});

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
