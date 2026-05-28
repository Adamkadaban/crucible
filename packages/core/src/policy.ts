// Policy / hardening primitives. These guard the host-side workflow so an
// operator can't accidentally share a host directory, request a download
// from an arbitrary location, or open egress on the analysis network.

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
  if (!isAbsolute(hostPath)) {
    return { allowed: false, reason: "host share path must be absolute" };
  }
  if (policy.allowedHostShareDirectories.length === 0) {
    return {
      allowed: false,
      reason: "policy denies host directory sharing; populate allowedHostShareDirectories first",
    };
  }
  for (const allowed of policy.allowedHostShareDirectories) {
    if (
      hostPath === allowed ||
      hostPath.startsWith(allowed.endsWith("/") ? allowed : `${allowed}/`)
    ) {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: `host share path is not inside any allowed directory` };
}

export function decideDownloadTarget(policy: CruciblePolicy, hostPath: string): PolicyDecision {
  if (isAbsolute(hostPath)) {
    return {
      allowed: false,
      reason: "download target must be relative; use one of the configured download directories",
    };
  }
  const first = hostPath.split(/[\\/]/u).filter(Boolean)[0];
  if (first === undefined) {
    return { allowed: false, reason: "download target is empty" };
  }
  const allowed = policy.allowedDownloadDirectories.some(
    (dir) =>
      hostPath === dir || hostPath.startsWith(dir.endsWith("/") ? dir : `${dir}/`) || dir === first,
  );
  return allowed
    ? { allowed: true }
    : { allowed: false, reason: "download target denied by policy" };
}

export function decideInternetEgress(policy: CruciblePolicy): PolicyDecision {
  return policy.allowInternetEgress
    ? { allowed: true }
    : { allowed: false, reason: "internet egress is denied by policy" };
}

function isAbsolute(target: string): boolean {
  return target.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(target);
}
