/**
 * SSRF / egress policy for navigation targets (literal hosts/IPs; not DNS-rebinding).
 */

import { classifyHost, type HostClassification } from "@fn-browser/utils/host-classification";

export { classifyHost };
export type { HostClassification };

export interface OriginPolicy {
  allowLoopback: boolean;
  allowPrivate: boolean;
  allowLinkLocal: boolean;
  /** Exact-host allowlist; a match is permitted regardless of classification. */
  allowHosts?: ReadonlySet<string>;
}

export interface NavigationDecision {
  allowed: boolean;
  classification: HostClassification;
  reason?: string;
}

/**
 * Local/dev default. Cloud-metadata endpoints stay blocked unless allowlisted.
 */
export const PERMISSIVE_ORIGIN_POLICY: OriginPolicy = {
  allowLoopback: true,
  allowPrivate: true,
  allowLinkLocal: true,
};

/** Hardened default for remote callers: only public hosts. */
export const REMOTE_ORIGIN_POLICY: OriginPolicy = {
  allowLoopback: false,
  allowPrivate: false,
  allowLinkLocal: false,
};

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "about:"]);

export function evaluateNavigationTarget(rawUrl: string, policy: OriginPolicy): NavigationDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      classification: "invalid",
      reason: `not a valid URL: ${rawUrl}`,
    };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      allowed: false,
      classification: "invalid",
      reason: `scheme "${url.protocol}" is not permitted (http/https only)`,
    };
  }

  // about:blank and friends have no host — benign.
  if (url.protocol === "about:") {
    return { allowed: true, classification: "public" };
  }

  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (policy.allowHosts?.has(host)) {
    return { allowed: true, classification: classifyHost(host) };
  }

  const classification = classifyHost(host);
  const blocked = (reason: string): NavigationDecision => ({
    allowed: false,
    classification,
    reason,
  });

  switch (classification) {
    case "cloud_metadata":
      return blocked(`navigation to the cloud metadata endpoint (${host}) is blocked`);
    case "invalid":
      return blocked(`invalid navigation host: ${host}`);
    case "loopback":
      return policy.allowLoopback
        ? { allowed: true, classification }
        : blocked(`loopback host ${host} is blocked by policy`);
    case "private":
      return policy.allowPrivate
        ? { allowed: true, classification }
        : blocked(`private host ${host} is blocked by policy`);
    case "link_local":
      return policy.allowLinkLocal
        ? { allowed: true, classification }
        : blocked(`link-local host ${host} is blocked by policy`);
    case "public":
      return { allowed: true, classification };
  }
}
