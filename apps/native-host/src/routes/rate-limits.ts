/**
 * HTTP route exposing the current rate-limit counter snapshot for the
 * side-panel readout.
 *
 *   GET /rate-limits → { counters: [{ tag, count, reset_at }] }
 */

import { Hono } from "hono";
import type { McpServer } from "@fntune/browser/mcp";
import type { AppEnv } from "../auth/capabilities.js";
import { LOCAL_PRINCIPAL } from "../auth/middleware.js";

export function createRateLimitsRouter(server: McpServer): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/", (c) => {
    // The snapshot exposes EVERY counter — including `session:<id>:<tag>` keys
    // carrying other principals' session ids — so it's an operator readout:
    // admin-only. (The local side panel runs as the admin LOCAL_PRINCIPAL.)
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (principal.tier !== "admin") {
      return c.json({ error: "forbidden", required: "admin" }, 403);
    }
    return c.json({ counters: server.policy.snapshotRateLimits() });
  });
  return app;
}
