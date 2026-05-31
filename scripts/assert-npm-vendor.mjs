#!/usr/bin/env node
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = path.join(root, "vendor", "crucible-guest-agent.exe");

try {
  const info = await stat(agent);
  if (!info.isFile() || info.size === 0) {
    throw new Error("not a non-empty file");
  }
} catch (error) {
  console.error(
    `Missing ${path.relative(root, agent)}. Run CRUCIBLE_VERSION=$(node -p "require('./package.json').version") scripts/package-release.sh before packing or publishing.`,
  );
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exit(1);
}
