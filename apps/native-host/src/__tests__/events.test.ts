import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { EventBus } from "../events/bus.js";
import { createEventsRouter } from "../routes/events.js";
import type { AppEnv } from "../auth/capabilities.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { parseAuthTokens } from "../auth/tokens.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("events SSE route", () => {
  it("streams operator events to a subscriber", async () => {
    const bus = new EventBus();
    const app = new Hono<AppEnv>();
    app.route("/events", createEventsRouter(bus));

    const res = await app.request("/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    // Let the handler's subscribeAll run before emitting.
    await tick();
    bus.emit("operator", "consent.requested", { id: "x" }, "2026-06-20T00:00:00.000Z");

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: consent.requested");
    expect(text).toContain('"id":"x"');

    await reader.cancel();
  });

  it("returns 503 when the subscriber cap is reached (DoS bound)", async () => {
    const bus = new EventBus();
    const app = new Hono<AppEnv>();
    // No auth middleware ⇒ LOCAL admin (has consent.approve), so the request
    // clears the capability gate and reaches the cap. maxSubscribers:0 makes the
    // cap fire on the first request — deterministic, no need to hold a stream.
    app.route("/events", createEventsRouter(bus, { maxSubscribers: 0 }));
    const res = await app.request("/events");
    expect(res.status).toBe(503);
  });

  it("forbids a principal without consent.approve", async () => {
    const bus = new EventBus();
    const app = new Hono<AppEnv>();
    app.use("*", createAuthMiddleware(parseAuthTokens("ci:tok_act:act")));
    app.route("/events", createEventsRouter(bus));
    const res = await app.request("/events", { headers: { Authorization: "Bearer tok_act" } });
    expect(res.status).toBe(403);
  });
});
