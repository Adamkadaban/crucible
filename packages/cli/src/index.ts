#!/usr/bin/env node
import {
  buildMediaCachePlan,
  defaultCrucibleConfig,
  getManualDownloadInstructions,
  type MediaCacheEntry,
  type MediaProfileName,
} from "@crucible/core";
import { BOOTSTRAP_TOOLS, getMcpServerBanner } from "@crucible/mcp-server";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export function runCrucibleCli(args: readonly string[]): CommandResult {
  const [command, ...rest] = args;

  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      return { exitCode: 0, stdout: getHelpText(), stderr: "" };
    case "media:plan":
      return renderMediaPlanCommand(rest);
    case "provision":
      return {
        exitCode: 0,
        stdout: [
          "crucible provision is scaffolded.",
          "Future phases will fetch media, build the VM, install WinDbg, and install the guest service.",
          getManualDownloadInstructions(),
        ].join("\n"),
        stderr: "",
      };
    case "mcp":
      return {
        exitCode: 0,
        stdout: [getMcpServerBanner(), "Bootstrap tools:", ...BOOTSTRAP_TOOLS.map(formatTool)].join(
          "\n",
        ),
        stderr: "",
      };
    default:
      return {
        exitCode: 2,
        stdout: "",
        stderr: `Unknown command: ${command}\n\n${getHelpText()}`,
      };
  }
}

function renderMediaPlanCommand(args: readonly string[]): CommandResult {
  const parsed = parseMediaPlanArgs(args);

  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message };
  }

  return { exitCode: 0, stdout: renderMediaPlan(parsed.profile), stderr: "" };
}

function renderMediaPlan(profile: MediaProfileName): string {
  const plan = buildMediaCachePlan({ ...defaultCrucibleConfig.media, profile });

  return [
    `Media profile: ${plan.profile}`,
    `Media cache: ${plan.cacheDirectory}`,
    "",
    "Planned media:",
    ...plan.entries.map(formatMediaEntry),
    "",
    getManualDownloadInstructions(plan.cacheDirectory),
  ].join("\n");
}

type MediaPlanArgsResult =
  | { readonly ok: true; readonly profile: MediaProfileName }
  | { readonly ok: false; readonly message: string };

function parseMediaPlanArgs(args: readonly string[]): MediaPlanArgsResult {
  let profile = defaultCrucibleConfig.media.profile;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--manual") {
      continue;
    }

    if (arg === "--profile") {
      const value = args[index + 1];

      if (value === undefined) {
        return { ok: false, message: "Missing value for --profile" };
      }

      if (!isMediaProfileName(value)) {
        return { ok: false, message: `Unknown media profile: ${value}` };
      }

      profile = value;
      index += 1;
      continue;
    }

    return { ok: false, message: `Unknown media:plan option: ${arg}` };
  }

  return { ok: true, profile };
}

function isMediaProfileName(value: string): value is MediaProfileName {
  return value === "windows11-enterprise-eval" || value === "windows-server-2025-eval";
}

function formatMediaEntry(entry: MediaCacheEntry): string {
  const source = entry.overridePath ?? entry.sourceUrl;
  const required = entry.required ? "required" : "optional";

  return `- ${entry.name} (${required}): ${source} -> ${entry.cachePath}`;
}

function formatTool(tool: (typeof BOOTSTRAP_TOOLS)[number]): string {
  return `- ${tool.name}: ${tool.description}`;
}

function getHelpText(): string {
  return [
    "crucible",
    "",
    "Usage:",
    "  crucible provision   Provision a Windows analysis VM (scaffolded)",
    "  crucible mcp         Start the MCP server (scaffolded)",
    "  crucible media:plan [--profile windows11-enterprise-eval|windows-server-2025-eval]",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runCrucibleCli(process.argv.slice(2));

  if (result.stdout.length > 0) {
    process.stdout.write(`${result.stdout}\n`);
  }

  if (result.stderr.length > 0) {
    process.stderr.write(`${result.stderr}\n`);
  }

  process.exitCode = result.exitCode;
}
