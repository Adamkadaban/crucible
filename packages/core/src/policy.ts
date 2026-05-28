// Policy / hardening primitives. These guard the host-side workflow so an
// operator can't accidentally share a host directory, request a download
// from an arbitrary location, or open egress on the analysis network.

import { isAbsolute as nodeIsAbsolute, normalize, resolve } from "node:path";

export type CruciblePolicy = {
  /** Absolute directories that the host is allowed to share with the guest. */
  readonly allowedHostShareDirectories: readonly string[];
  /** Allowed top-level download targets on the host. */
  readonly allowedDownloadDirectories: readonly string[];
  /** Whether the analysis VM may reach the public Internet. */
  readonly allowInternetEgress: boolean;
};

export const DEFAULT_POLICY: CruciblePolicy = {
  allowedHostShareDirectories: [],
  allowedDownloadDirectories: ["artifacts/downloads"],
  allowInternetEgress: false,
};

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function decideHostShare(policy: CruciblePolicy, hostPath: string): PolicyDecision {
  if (!nodeIsAbsolute(hostPath)) {
    return { allowed: false, reason: "host share path must be absolute" };
  }
  if (policy.allowedHostShareDirectories.length === 0) {
    return {
      allowed: false,
      reason: "policy denies host directory sharing; populate allowedHostShareDirectories first",
    };
  }
  // Resolve both candidate and allowlist entries so '..' segments cannot
  // escape an allowed prefix (e.g. /var/lib/crucible/../secrets).
  const candidate = resolve(hostPath);
  for (const allowed of policy.allowedHostShareDirectories) {
    if (!nodeIsAbsolute(allowed)) continue;
    const allowedResolved = resolve(allowed);
    const allowedWithSep = allowedResolved.endsWith("/") ? allowedResolved : `${allowedResolved}/`;
    if (candidate === allowedResolved || candidate.startsWith(allowedWithSep)) {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: `host share path is not inside any allowed directory` };
}

export function decideDownloadTarget(policy: CruciblePolicy, hostPath: string): PolicyDecision {
  if (nodeIsAbsolute(hostPath)) {
    return {
      allowed: false,
      reason: "download target must be relative; use one of the configured download directories",
    };
  }
  // Normalize first so '..' segments resolve before we evaluate the prefix.
  const normalized = normalize(hostPath).replaceAll("\\", "/");
  if (normalized === "" || normalized === "." || normalized.startsWith("..")) {
    return { allowed: false, reason: "download target escapes its directory" };
  }
  for (const dir of policy.allowedDownloadDirectories) {
    const dirNormalized = normalize(dir).replaceAll("\\", "/").replace(/\/$/u, "");
    if (dirNormalized === "" || dirNormalized === ".") continue;
    if (normalized === dirNormalized || normalized.startsWith(`${dirNormalized}/`)) {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: "download target denied by policy" };
}

export function decideInternetEgress(policy: CruciblePolicy): PolicyDecision {
  return policy.allowInternetEgress
    ? { allowed: true }
    : { allowed: false, reason: "internet egress is denied by policy" };
}
