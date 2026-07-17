/** Operator SSE firehose — gated on consent.approve (carries consent bodies). */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../auth/capabilities.js";
import { LOCAL_PRINCIPAL } from "../auth/middleware.js";
import type { EventBus } from "../events/bus.js";

const DEFAULT_MAX_SUBSCRIBERS = 64;

export function createEventsRouter(
  bus: EventBus,
  opts: { maxSubscribers?: number } = {},
): Hono<AppEnv> {
  const maxSubscribers = opts.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
  let active = 0;
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;
    if (!principal.capabilities.has("consent.approve")) {
      return c.json({ error: "forbidden", required: "consent.approve" }, 403);
    }
    if (active >= maxSubscribers) {
      return c.json({ error: "too many event subscribers" }, 503);
    }
    return streamSSE(c, async (stream) => {
      active++;
      const unsubscribe = bus.subscribeAll((channel, event) => {
        void stream.writeSSE({
          event: event.topic,
          data: JSON.stringify({ channel, payload: event.payload, at: event.at }),
        });
      });
      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(resolve);
        });
      } finally {
        unsubscribe();
        active--;
      }
    });
  });

  return app;
}
