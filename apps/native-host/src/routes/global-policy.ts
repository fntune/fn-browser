/** Global HITL override routes; destructive actions still prompt. */

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

/** Seed global policy from FN_BROWSER_GLOBAL_POLICY for unattended runs. */
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
  /** When env-pinned, runtime writes are refused (side panel can't clobber). */
  envLocked = false,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    return c.json({ policy: server.policy.getGlobalPolicy(), ...(envLocked ? { locked: true } : {}) });
  });

  app.post("/", async (c) => {
    // policy.write required for remote callers; local admin passes.
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (!principal.capabilities.has("policy.write")) {
      return c.json({ error: "forbidden", required: "policy.write" }, 403);
    }
    // Env-pinned — no-op write, return authoritative value.
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
