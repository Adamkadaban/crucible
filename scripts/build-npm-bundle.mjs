#!/usr/bin/env node
import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "cli.js");

await mkdir(path.dirname(output), { recursive: true });

await build({
  entryPoints: [path.join(root, "packages", "cli", "src", "index.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["undici"],
  sourcemap: false,
});

await chmod(output, 0o755);
console.error(`[bundle] wrote ${path.relative(root, output)}`);
