/** Rate-limit counter snapshot for side panel — admin-only (cross-session keys). */

import { Hono } from "hono";
import type { McpServer } from "@fntune/browser/mcp";
import type { AppEnv } from "../auth/capabilities.js";
import { LOCAL_PRINCIPAL } from "../auth/middleware.js";

export function createRateLimitsRouter(server: McpServer): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/", (c) => {
    // Snapshot includes other principals' session keys — admin-only.
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (principal.tier !== "admin") {
      return c.json({ error: "forbidden", required: "admin" }, 403);
    }
    return c.json({ counters: server.policy.snapshotRateLimits() });
  });
  return app;
}
