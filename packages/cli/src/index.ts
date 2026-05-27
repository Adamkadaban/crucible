#!/usr/bin/env node
import { getManualDownloadInstructions } from "@crucible/core";
import { BOOTSTRAP_TOOLS, getMcpServerBanner } from "@crucible/mcp-server";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export function runCrucibleCli(args: readonly string[]): CommandResult {
  const [command] = args;

  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      return { exitCode: 0, stdout: getHelpText(), stderr: "" };
    case "media:plan":
      return { exitCode: 0, stdout: getManualDownloadInstructions(), stderr: "" };
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
