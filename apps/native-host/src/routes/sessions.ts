/**
 * HTTP routes for operators (side panel / remote) to list and control sessions.
 *
 *   GET  /sessions                          list all sessions       (sessions.read)
 *   POST /sessions/:id/policy { policy }     set HITL policy         (policy.write)
 *
 * Capability-gated: writing a session's HITL policy can flip it to `act` (which
 * auto-allows non-destructive consent), so it requires `policy.write` exactly
 * like the global policy — otherwise a low-tier caller could escalate consent.
 */

import { Hono } from "hono";
import type { McpServer } from "@fntune/browser/mcp";
import type { HitlMode, SessionId } from "@fntune/browser/cdp";
import type { AppEnv } from "../auth/capabilities.js";
import { LOCAL_PRINCIPAL } from "../auth/middleware.js";

const VALID_POLICIES: ReadonlySet<HitlMode> = new Set<HitlMode>([
  "ask",
  "follow_plan",
  "act",
]);

export function createSessionsRouter(server: McpServer): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (!principal.capabilities.has("sessions.read")) {
      return c.json({ error: "forbidden", required: "sessions.read" }, 403);
    }
    // Admin tier sees all (operator console); others see only their own sessions
    // (plus unowned), matching the list_sessions tool filter.
    const sessions = server.sessions
      .list()
      .filter(
        (s) =>
          principal.tier === "admin" ||
          s.ownerPrincipalId === null ||
          s.ownerPrincipalId === principal.id,
      )
      .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      tabGroupId: s.tabGroupId,
      windowId: s.windowId,
      policy: s.policy,
      ownedTabCount: s.ownedTabs.size,
      workflowRunIds: s.workflowRunIds,
      createdAt: s.createdAt.toISOString(),
      lastHeartbeat: s.lastHeartbeat.toISOString(),
    }));
    return c.json({ sessions });
  });

  app.post("/:id/policy", async (c) => {
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (!principal.capabilities.has("policy.write")) {
      return c.json({ error: "forbidden", required: "policy.write" }, 403);
    }
    const id = c.req.param("id") as SessionId;
    const body = (await c.req.json().catch(() => null)) as { policy?: string } | null;
    const policy = body?.policy;
    if (!policy || !VALID_POLICIES.has(policy as HitlMode)) {
      return c.json(
        {
          ok: false,
          error: `policy must be one of: ${Array.from(VALID_POLICIES).join(", ")}`,
        },
        400,
      );
    }
    const session = server.sessions.get(id);
    if (!session) {
      return c.json({ ok: false, error: "session not found" }, 404);
    }
    server.sessions.setPolicy(id, policy as HitlMode);
    return c.json({ ok: true });
  });

  return app;
}
