/**
 * Hono auth middleware — bearer token or trusted identity header → Principal.
 * Empty token table → local admin (localhost-trust).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import {
  TIER_CAPABILITIES,
  type AppEnv,
  type Capability,
  type Principal,
} from "./capabilities.js";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export const LOCAL_PRINCIPAL: Principal = {
  id: "local",
  tier: "admin",
  capabilities: TIER_CAPABILITIES.admin,
};

const DEFAULT_IDENTITY_HEADER = "Tailscale-User-Login";

export interface IdentityAuthOptions {
  /**
   * Trust verified identity header from upstream proxy — only safe on loopback bind.
   */
  trustIdentityHeader?: boolean;
  identityHeaderName?: string;
  /** login (lower-cased) → principal, from FN_BROWSER_IDENTITY_TIERS. */
  identities?: Map<string, Principal>;
}

export function createAuthMiddleware(
  principals: Map<string, Principal>,
  identity: IdentityAuthOptions = {},
): MiddlewareHandler<AppEnv> {
  const identities = identity.identities ?? new Map<string, Principal>();
  const trustHeader = identity.trustIdentityHeader === true && identities.size > 0;
  const headerName = identity.identityHeaderName ?? DEFAULT_IDENTITY_HEADER;
  const enabled = principals.size > 0 || trustHeader;

  // Precompute digests for constant-time bearer lookup (no Map.get timing leak).
  const tokenDigests: Array<{ digest: Buffer; principal: Principal }> = [];
  for (const [token, principal] of principals) {
    tokenDigests.push({ digest: sha256(token), principal });
  }

  return async (c, next) => {
    // OPTIONS has no Authorization — pass through to CORS middleware.
    if (c.req.method === "OPTIONS") {
      return next();
    }
    if (!enabled) {
      c.set("principal", LOCAL_PRINCIPAL);
      return next();
    }
    // Constant-time digest compare — no early exit on match position.
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    let principal: Principal | undefined;
    if (token) {
      const reqDigest = sha256(token);
      for (const entry of tokenDigests) {
        if (timingSafeEqual(entry.digest, reqDigest)) principal = entry.principal;
      }
    }
    // Fall back to the trusted tailnet identity header (audit-grade login).
    if (!principal && trustHeader) {
      const login = c.req.header(headerName);
      if (login) principal = identities.get(login.toLowerCase());
    }
    if (!principal) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("principal", principal);
    return next();
  };
}

/** Route guard: 403 unless principal holds `capability`. */
export function requireCapability(capability: Capability): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal || !principal.capabilities.has(capability)) {
      return c.json({ error: "forbidden", required: capability }, 403);
    }
    return next();
  };
}
