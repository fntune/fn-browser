/**
 * Hono auth middleware — bearer token → Principal.
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

export function createAuthMiddleware(principals: Map<string, Principal>): MiddlewareHandler<AppEnv> {
  const enabled = principals.size > 0;

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
