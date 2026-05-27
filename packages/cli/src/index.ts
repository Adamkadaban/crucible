#!/usr/bin/env node
import {
  buildQemuCommandPlan,
  defaultCrucibleConfig,
  getManualDownloadInstructions,
  loadCrucibleConfigFile,
  renderQemuCreateDryRun,
  renderQemuStartDryRun,
  type CrucibleConfig,
} from "@crucible/core";
import { BOOTSTRAP_TOOLS, getMcpServerBanner } from "@crucible/mcp-server";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CliRuntime = {
  readonly config?: CrucibleConfig;
  readonly configPath?: string;
};

export function runCrucibleCli(args: readonly string[], runtime: CliRuntime = {}): CommandResult {
  const [command] = args;

  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      return { exitCode: 0, stdout: getHelpText(), stderr: "" };
    case "media:plan":
      return { exitCode: 0, stdout: getManualDownloadInstructions(), stderr: "" };
    case "vm:create":
    case "vm:start":
      return runVmDryRun(command, args.slice(1), runtime);
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

function runVmDryRun(
  command: "vm:create" | "vm:start",
  args: readonly string[],
  runtime: CliRuntime,
): CommandResult {
  if (!args.includes("--dry-run")) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${command} currently supports --dry-run only.`,
    };
  }

  const plan = buildQemuCommandPlan({ config: getRuntimeConfig(runtime) });
  const action = command === "vm:create" ? "create" : "start";
  const dryRun =
    command === "vm:create" ? renderQemuCreateDryRun(plan) : renderQemuStartDryRun(plan);

  return {
    exitCode: 0,
    stdout: [`VM ${action} dry run:`, dryRun].join("\n"),
    stderr: "",
  };
}

function getRuntimeConfig(runtime: CliRuntime): CrucibleConfig {
  if (runtime.config !== undefined) {
    return runtime.config;
  }

  if (runtime.configPath !== undefined) {
    return loadCrucibleConfigFile(runtime.configPath);
  }

  return defaultCrucibleConfig;
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
    "  crucible media:plan  Print default and manual media download locations",
    "  crucible vm:create --dry-run  Print the planned qcow2 creation and QEMU inputs",
    "  crucible vm:start --dry-run   Print the planned QEMU argv and sockets",
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
