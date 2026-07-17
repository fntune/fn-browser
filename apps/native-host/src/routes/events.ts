/**
 * Operator event stream (SSE). Subscribers receive the daemon firehose —
 * `consent.requested`/`consent.resolved` and (future) run/session progress —
 * so a remote operator console can react to prompts the way the local side
 * panel does.
 *
 * Gated on `consent.approve`: the firehose carries consent bodies, so only a
 * principal that may act on consents may watch them. Subscribers are capped to
 * bound memory/fan-out from an authenticated caller.
 *
 *   GET /events   text/event-stream
 */

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
        // Hold open until the client disconnects; no heartbeat timer to leak.
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
