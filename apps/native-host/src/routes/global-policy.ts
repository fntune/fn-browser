/**
 * HTTP route for the side panel to read/write the global HITL override.
 *
 *   GET  /global-policy             { policy: HitlMode | null }
 *   POST /global-policy { policy }   policy: HitlMode | null
 *
 * When policy is non-null, every session behaves as if its per-session policy
 * were this value — destructive actions still prompt (invariant).
 *
 * Localhost-only; no auth (matches /mcp/browser).
 */

import { Hono } from "hono";
import type { McpServer } from "@fntune/browser/mcp";
import type { HitlMode } from "@fntune/browser/cdp";
import type { AppEnv } from "../auth/capabilities.js";
import { LOCAL_PRINCIPAL } from "../auth/middleware.js";

export const VALID_POLICIES: ReadonlySet<HitlMode> = new Set<HitlMode>([
  "ask",
  "follow_plan",
  "act",
]);

export type GlobalPolicyEnvOutcome =
  | { applied: HitlMode }
  | { ignored: string }
  | null;

/**
 * Seed the global HITL policy from `FN_BROWSER_GLOBAL_POLICY` for unattended
 * runs (no human at the side panel). Returns what happened so the caller can
 * log it (effects stay at the edge). Unset → null; invalid → `{ ignored }`;
 * valid → set on the store and `{ applied }`.
 */
export function applyGlobalPolicyFromEnv(
  server: McpServer,
  env: Record<string, string | undefined> = process.env,
): GlobalPolicyEnvOutcome {
  const raw = env.FN_BROWSER_GLOBAL_POLICY;
  if (!raw) return null;
  if (!VALID_POLICIES.has(raw as HitlMode)) return { ignored: raw };
  server.policy.setGlobalPolicy(raw as HitlMode);
  return { applied: raw as HitlMode };
}

export function createGlobalPolicyRouter(
  server: McpServer,
  onChange?: (policy: HitlMode | null, principalId: string, previous: HitlMode | null) => void,
  /**
   * When the policy is pinned by `FN_BROWSER_GLOBAL_POLICY`, runtime writes are
   * refused so a side-panel mount (which POSTs its cached `chrome.storage` value)
   * can't clobber the env-selected policy. The write becomes a no-op that returns
   * the authoritative value so the caller re-syncs.
   */
  envLocked = false,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    return c.json({ policy: server.policy.getGlobalPolicy(), ...(envLocked ? { locked: true } : {}) });
  });

  app.post("/", async (c) => {
    // Writing the global HITL policy is privileged. The local admin principal
    // (auth disabled / isolated tests) passes; remote callers need policy.write.
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (!principal.capabilities.has("policy.write")) {
      return c.json({ error: "forbidden", required: "policy.write" }, 403);
    }
    // Env-pinned policy is authoritative — ignore the write, return current value.
    if (envLocked) {
      return c.json({ policy: server.policy.getGlobalPolicy(), locked: true });
    }
    const body = (await c.req.json().catch(() => null)) as
      | { policy?: string | null }
      | null;
    if (!body || !("policy" in body)) {
      return c.json({ error: "body must include { policy: <mode|null> }" }, 400);
    }
    const raw = body.policy;
    if (raw !== null && !VALID_POLICIES.has(raw as HitlMode)) {
      return c.json(
        {
          error: `policy must be null or one of ${[...VALID_POLICIES].join(", ")}`,
        },
        400,
      );
    }
    const previous = server.policy.getGlobalPolicy();
    const next = (raw ?? null) as HitlMode | null;
    server.policy.setGlobalPolicy(next);
    onChange?.(next, principal.id, previous);
    return c.json({ policy: server.policy.getGlobalPolicy() });
  });

  return app;
}
