/** Operator consent routes — list pending and resolve (consent.approve). */

import { Hono } from "hono";
import type { AppEnv } from "../auth/capabilities.js";
import { LOCAL_PRINCIPAL } from "../auth/middleware.js";
import type { ConsentRegistry } from "../consent/registry.js";

export function createConsentsRouter(registry: ConsentRegistry): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (!principal.capabilities.has("consent.approve")) {
      return c.json({ error: "forbidden", required: "consent.approve" }, 403);
    }
    return c.json({ consents: registry.list() });
  });

  app.post("/:id/resolve", async (c) => {
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (!principal.capabilities.has("consent.approve")) {
      return c.json({ error: "forbidden", required: "consent.approve" }, 403);
    }
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as { choice?: string } | null;
    if (!body || typeof body.choice !== "string" || body.choice.length === 0) {
      return c.json({ error: "body must include { choice: string }" }, 400);
    }
    const result = registry.resolve(id, body.choice, principal.id);
    if (!result.ok) {
      if (result.reason === "local_only") {
        // 403 not 404 — consent exists but remote operator may not resolve it.
        return c.json(
          { error: "local_only", message: "This consent can only be resolved by the local user." },
          403,
        );
      }
      if (result.reason === "invalid_choice") {
        return c.json({ error: "invalid_choice", message: "choice is not one this consent offered" }, 400);
      }
      return c.json({ error: "no pending consent with that id" }, 404);
    }
    return c.json({ resolved: true, id, choice: body.choice });
  });

  return app;
}
