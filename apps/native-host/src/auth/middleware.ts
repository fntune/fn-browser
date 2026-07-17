/**
 * Hono middleware: authenticate a bearer token to a Principal, and a guard to
 * require a capability on a route.
 *
 * When the token table is empty (no `FN_BROWSER_AUTH_TOKENS`), auth is disabled
 * — every request runs as a synthetic local `admin` principal, preserving the
 * current localhost-trust behavior. When the table is non-empty (daemon/remote
 * mode), every request must carry `Authorization: Bearer <token>` or gets 401.
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
   * Trust a verified identity header injected by an upstream proxy (the tsnet
   * sidecar / `tailscale serve`). ONLY safe when the daemon is reachable solely
   * via that upstream — bind loopback so a direct client can't spoof the header.
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

  // Precompute fixed-length token digests so bearer lookup is constant-time
  // (matches the WS token's timingSafeEqual): a raw Map.get leaks a timing
  // signal on the secret token. Hashing to 32 bytes also avoids length leaks.
  const tokenDigests: Array<{ digest: Buffer; principal: Principal }> = [];
  for (const [token, principal] of principals) {
    tokenDigests.push({ digest: sha256(token), principal });
  }

  return async (c, next) => {
    // CORS preflight carries no Authorization header — let it through to the
    // CORS middleware, which answers it before any route runs.
    if (c.req.method === "OPTIONS") {
      return next();
    }
    if (!enabled) {
      c.set("principal", LOCAL_PRINCIPAL);
      return next();
    }
    // Bearer token is the primary authorization. Constant-time lookup: compare
    // the request token's digest against every known digest without early exit
    // (so neither a match's position nor the token content leaks via timing).
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

/**
 * Route guard: 403 unless the authenticated principal holds `capability`.
 * Assumes createAuthMiddleware ran first (principal is set).
 */
export function requireCapability(capability: Capability): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal || !principal.capabilities.has(capability)) {
      return c.json({ error: "forbidden", required: capability }, 403);
    }
    return next();
  };
}
