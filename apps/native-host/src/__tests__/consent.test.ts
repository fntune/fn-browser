import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Hono } from "hono";

import { EventBus, type BusEvent } from "../events/bus.js";
import { AuditLog, type AuditEntry } from "../observability/audit.js";
import { ConsentRegistry } from "../consent/registry.js";
import { createConsentsRouter } from "../routes/consents.js";
import { createMcpServer } from "../mcp-server.js";
import { ExtensionBridge } from "../extension-bridge.js";
import { NativeMessagingBridge } from "../native-messaging.js";
import type { AppEnv } from "../auth/capabilities.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { parseAuthTokens } from "../auth/tokens.js";
import type { ToolResult } from "@fntune/browser/mcp";

const noopAudit = { append: async () => {} } as unknown as AuditLog;

function bridgeReplying(reply: () => ToolResult): ExtensionBridge {
  const bridge = new ExtensionBridge(new NativeMessagingBridge(new PassThrough(), new PassThrough()));
  Object.defineProperty(bridge, "isConnected", { get: () => true });
  Object.assign(bridge, { async sendCommand() { return reply(); } });
  return bridge;
}

describe("EventBus", () => {
  it("delivers to channel subscribers and the firehose", () => {
    const bus = new EventBus();
    const ch: string[] = [];
    const all: string[] = [];
    bus.subscribe("operator", (_c, e) => ch.push(e.topic));
    bus.subscribeAll((_c, e) => all.push(e.topic));
    bus.emit("operator", "consent.requested", { id: "1" }, "t");
    bus.emit("run:5", "tool.start", {}, "t");
    expect(ch).toEqual(["consent.requested"]);
    expect(all).toEqual(["consent.requested", "tool.start"]);
  });

  it("unsubscribe stops delivery and isolates throwing handlers", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribeAll(() => {
      throw new Error("boom");
    });
    const unsub = bus.subscribe("operator", (_c, e) => seen.push(e.topic));
    expect(() => bus.emit("operator", "a", {}, "t")).not.toThrow();
    unsub();
    bus.emit("operator", "b", {}, "t");
    expect(seen).toEqual(["a"]);
  });
});

describe("AuditLog", () => {
  it("appends one jsonl line per entry under ~/.fn-browser/audit", async () => {
    const audit = new AuditLog(() => new Date("2026-06-20T00:00:00.000Z"));
    await audit.append({ kind: "consent.requested", id: "audit-abc" });
    await audit.append({ kind: "consent.resolved", id: "audit-abc", choice: "allow" });
    const file = join(process.env.HOME ?? "", ".fn-browser", "audit", "2026-06-20.jsonl");
    const lines = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.id === "audit-abc");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "consent.requested", at: "2026-06-20T00:00:00.000Z" });
    expect(lines[1]).toMatchObject({ kind: "consent.resolved", choice: "allow" });
  });
});

describe("ConsentRegistry", () => {
  function makeRegistry() {
    const bus = new EventBus();
    const events: BusEvent[] = [];
    bus.subscribeAll((_c, e) => events.push(e));
    let n = 0;
    const registry = new ConsentRegistry(bus, noopAudit, () => `c${n++}`, () => new Date("2026-06-20T00:00:00.000Z"));
    return { registry, events };
  }

  it("resolves via a successful extension reply (first settlement wins)", async () => {
    const { registry, events } = makeRegistry();
    const res = await registry.request(
      { title: "t", body: "b" },
      async () => ({ ok: true, result: { choice: "allow" } }),
      {},
    );
    expect(res).toEqual({ ok: true, result: { choice: "allow" } });
    expect(events.map((e) => e.topic)).toEqual(["consent.requested", "consent.resolved"]);
  });

  it("ignores an unreachable extension and resolves via a remote operator (attributed)", async () => {
    const { registry, events } = makeRegistry();
    const p = registry.request(
      { title: "t", body: "b" },
      async () => ({ ok: false, error: { code: "extension_unreachable", message: "x" } }),
      {},
    );
    await Promise.resolve();
    expect(registry.list().map((c) => c.id)).toEqual(["c0"]);
    expect(registry.resolve("c0", "deny", "operator-alice")).toEqual({ ok: true });
    expect(await p).toEqual({ ok: true, result: { choice: "deny" } });
    expect(registry.list()).toHaveLength(0);
    // The approving operator is recorded for the audit trail.
    const resolved = events.find((e) => e.topic === "consent.resolved");
    expect((resolved?.payload as { approvedBy?: string }).approvedBy).toBe("operator-alice");
  });

  it("times out with the cdp_timeout shape PolicyStore understands", async () => {
    const { registry } = makeRegistry();
    const res = await registry.request(
      { title: "t", body: "b" },
      async () => ({ ok: false, error: { code: "extension_unreachable", message: "x" } }),
      { timeoutMs: 10 },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("cdp_timeout");
      expect(res.error.message).toMatch(/timed out/i);
    }
  });

  it("cancels and removes a pending consent when its request aborts", async () => {
    const { registry } = makeRegistry();
    const controller = new AbortController();
    const pending = registry.request(
      { title: "t", body: "b" },
      () => new Promise<ToolResult>(() => {}),
      { signal: controller.signal },
    );
    await Promise.resolve();
    expect(registry.list().map((consent) => consent.id)).toEqual(["c0"]);

    controller.abort();

    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "request_cancelled" },
    });
    expect(registry.list()).toHaveLength(0);
    expect(registry.resolve("c0", "allow")).toEqual({ ok: false, reason: "unknown" });
  });

  it("refuses operator resolution of a local-only consent, but the local extension can settle it", async () => {
    const { registry } = makeRegistry();
    let settleForward!: (r: ToolResult) => void;
    const forward = () => new Promise<ToolResult>((res) => { settleForward = res; });
    const p = registry.request({ title: "adopt", body: "b", localOnly: true }, forward, {});
    await Promise.resolve();
    // A remote operator CANNOT approve a local-only handoff.
    expect(registry.resolve("c0", "allow", "ops")).toEqual({ ok: false, reason: "local_only" });
    expect(registry.list()[0]).toMatchObject({ localOnly: true });
    // The local user (extension side panel) CAN settle it.
    settleForward({ ok: true, result: { choice: "allow" } });
    expect(await p).toEqual({ ok: true, result: { choice: "allow" } });
  });

  it("fails a local-only consent fast when the extension forward fails (no 10-min hang)", async () => {
    const { registry } = makeRegistry();
    // Extension forward fails (e.g. WS dropped). A local-only consent can't be
    // resolved by an operator, so it must settle now, not wait for the timeout.
    const result = await registry.request(
      { title: "adopt", body: "b", localOnly: true },
      async () => ({ ok: false as const, error: { code: "extension_unreachable", message: "ws closed" } }),
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("extension_unreachable");
  });

  it("rejects an operator choice that isn't one of the prompt's options", async () => {
    const { registry } = makeRegistry();
    const p = registry.request(
      { title: "tos", body: "b", options: ["accept", "decline"] },
      () => new Promise<ToolResult>(() => {}), // extension never settles
      {},
    );
    await Promise.resolve();
    expect(registry.resolve("c0", "allow", "ops")).toEqual({ ok: false, reason: "invalid_choice" }); // not offered
    expect(registry.resolve("c0", "accept", "ops")).toEqual({ ok: true }); // valid
    expect(await p).toEqual({ ok: true, result: { choice: "accept" } });
  });

  it("resolve returns false for unknown or already-settled ids", async () => {
    const { registry } = makeRegistry();
    expect(registry.resolve("nope", "allow")).toEqual({ ok: false, reason: "unknown" });
    const p = registry.request({ title: "t", body: "b" }, async () => ({ ok: true, result: { choice: "allow" } }), {});
    await p;
    expect(registry.resolve("c0", "allow")).toEqual({ ok: false, reason: "unknown" }); // settled
  });

  it("rejects new consents over the pending cap (DoS guard) and audits the overload", async () => {
    const bus = new EventBus();
    let n = 0;
    // Collect audit entries so we can assert the overload is recorded.
    const entries: AuditEntry[] = [];
    const collectingAudit = {
      append: async (e: AuditEntry) => {
        entries.push(e);
      },
    } as unknown as AuditLog;
    // cap = 1: one pending allowed, the next is rejected.
    const registry = new ConsentRegistry(bus, collectingAudit, () => `c${n++}`, () => new Date(), 1);
    const pending = registry.request(
      { title: "t", body: "b" },
      async () => ({ ok: false, error: { code: "x", message: "y" } }),
      {},
    );
    await Promise.resolve();
    const over = await registry.request({ title: "t2", body: "b2" }, async () => ({ ok: true, result: { choice: "allow" } }), {});
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("consent_overloaded");
    // The overload was recorded in the audit trail.
    expect(entries.some((e) => e.kind === "consent.rejected_overload")).toBe(true);
    // First one still resolvable.
    expect(registry.resolve("c0", "deny")).toEqual({ ok: true });
    expect(await pending).toEqual({ ok: true, result: { choice: "deny" } });
  });
});

describe("consent routes", () => {
  function appWith(registry: ConsentRegistry, tokens?: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use("*", createAuthMiddleware(parseAuthTokens(tokens)));
    app.route("/consents", createConsentsRouter(registry));
    return app;
  }

  it("lists pending and resolves via POST", async () => {
    const registry = new ConsentRegistry(new EventBus(), noopAudit, () => "fixed-id");
    const app = appWith(registry);
    const pending = registry.request(
      { title: "t", body: "b" },
      async () => ({ ok: false, error: { code: "x", message: "y" } }),
      {},
    );
    await Promise.resolve();

    const list = (await (await app.request("/consents")).json()) as { consents: Array<{ id: string }> };
    expect(list.consents.map((c) => c.id)).toEqual(["fixed-id"]);

    const r = await app.request("/consents/fixed-id/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "allow" }),
    });
    expect(r.status).toBe(200);
    expect(await pending).toEqual({ ok: true, result: { choice: "allow" } });
  });

  it("404s an unknown id and 400s a missing choice", async () => {
    const registry = new ConsentRegistry(new EventBus(), noopAudit);
    const app = appWith(registry);
    const missing = await app.request("/consents/nope/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "allow" }),
    });
    expect(missing.status).toBe(404);
    const bad = await app.request("/consents/x/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });

  it("403s (not 404s) an operator resolving a local-only consent", async () => {
    const registry = new ConsentRegistry(new EventBus(), noopAudit, () => "lo-id");
    const app = appWith(registry);
    // Forward BLOCKS (extension hasn't replied and the link is up) so the
    // consent stays pending for the operator attempt; a short timeout then
    // cleans it up. (A failing forward would now fast-settle a local-only
    // consent — see the registry test — so it must not fail here.)
    const pending = registry.request(
      { title: "adopt", body: "b", localOnly: true },
      () => new Promise<ToolResult>(() => {}),
      { timeoutMs: 20 },
    );
    await Promise.resolve();
    const res = await app.request("/consents/lo-id/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "allow" }),
    });
    // The consent EXISTS but a remote operator may not resolve it — 403, not 404.
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("local_only");
    await pending; // let it time out so no timer lingers
  });

  it("403s a principal without consent.approve", async () => {
    const registry = new ConsentRegistry(new EventBus(), noopAudit);
    const app = appWith(registry, "ci:tok_act:act");
    const res = await app.request("/consents", { headers: { Authorization: "Bearer tok_act" } });
    expect(res.status).toBe(403);
  });
});

describe("daemon consent integration through createMcpServer", () => {
  it("routes require_consent through the registry and emits on the bus", async () => {
    const bus = new EventBus();
    const topics: string[] = [];
    bus.subscribeAll((_c, e) => topics.push(e.topic));
    const registry = new ConsentRegistry(bus, noopAudit);
    const { app } = createMcpServer({
      bridge: bridgeReplying(() => ({ ok: true, result: { choice: "allow" } })),
      consent: registry,
    });

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "require_consent", arguments: { title: "Submit?", body: "send it", destructive: true } },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({ choice: "allow" });
    expect(topics).toEqual(["consent.requested", "consent.resolved"]);
  });
});
