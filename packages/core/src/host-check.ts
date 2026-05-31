import { access, constants } from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";

export type HostCheckProbeResult = {
  readonly healthy: boolean;
  readonly missing: readonly string[];
  readonly notes?: string;
  readonly platform: string;
  readonly arch: string;
};

const REQUIRED_BINARIES = ["qemu-system-x86_64", "qemu-img", "xorriso", "swtpm", "socat"] as const;

const KVM_PATH = "/dev/kvm";
const OVMF_CODE_CANDIDATES = [
  "/usr/share/OVMF/OVMF_CODE_4M.fd",
  "/usr/share/edk2-ovmf/OVMF_CODE.fd",
  "/usr/share/edk2/x64/OVMF_CODE.fd",
];

/**
 * Probe the Linux host for the prerequisites Crucible needs before it can
 * launch an analysis VM. Returns a structured payload that the MCP and CLI
 * `host_check` surfaces can render uniformly.
 */
export async function runHostCheck(): Promise<HostCheckProbeResult> {
  const missing: string[] = [];
  if (os.platform() !== "linux") {
    missing.push("linux-host");
  }

  for (const bin of REQUIRED_BINARIES) {
    const found = await hasCommand(bin);
    if (!found) missing.push(`bin:${bin}`);
  }

  if (!(await pathReadable(KVM_PATH))) {
    missing.push("device:/dev/kvm");
  }

  let foundOvmf = false;
  for (const candidate of OVMF_CODE_CANDIDATES) {
    if (await pathReadable(candidate)) {
      foundOvmf = true;
      break;
    }
  }
  if (!foundOvmf) missing.push("firmware:OVMF_CODE.fd");

  return {
    healthy: missing.length === 0,
    missing,
    platform: os.platform(),
    arch: os.arch(),
    notes:
      missing.length === 0
        ? "host prerequisites satisfied"
        : `missing prerequisites: ${missing.join(", ")}`,
  };
}

async function pathReadable(target: string): Promise<boolean> {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hasCommand(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [name], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}
