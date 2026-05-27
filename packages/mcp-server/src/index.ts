import { CRUCIBLE_VERSION } from "@crucible/core";

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
];

export function getMcpServerBanner(): string {
  return `crucible MCP server ${CRUCIBLE_VERSION}`;
}
