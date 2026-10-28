import { describe, expect, it } from "vitest";

import { Hono } from "hono";
import { createBrowserMcpServer, PolicyStore, SessionRegistry } from "@fn-browser/browser/mcp";
import type { TransportBridge, ToolResult } from "@fn-browser/browser/mcp";
import type { SessionId } from "@fn-browser/browser/cdp";
import { createSessionsRouter } from "../routes/sessions.js";
import {
  createGlobalPolicyRouter,
  applyGlobalPolicyFromEnv,
} from "../routes/global-policy.js";

function stubBridge(): TransportBridge {
  return {
    isConnected: true,
    async sendToExtension(): Promise<ToolResult> {
      return { ok: true, result: {} };
    },
  };
}

async function buildApp() {
  const registry = new SessionRegistry();
  const policy = new PolicyStore(registry);
  const server = createBrowserMcpServer({
    bridge: stubBridge(),
    sessionRegistry: registry,
    policyStore: policy,
  });

  const app = new Hono();
  app.route("/sessions", createSessionsRouter(server));
  app.route("/global-policy", createGlobalPolicyRouter(server));
  return { app, server };
}

describe("GET /sessions", () => {
  it("returns empty list when no sessions", async () => {
    const { app } = await buildApp();
    const res = await app.request("/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  it("returns live session metadata", async () => {
    const { app, server } = await buildApp();
    const start = await server.callTool("start", { name: "demo", color: "blue" });
    expect(start.ok).toBe(true);

    const res = await app.request("/sessions");
    const body = (await res.json()) as {
      sessions: Array<{ id: string; name: string; color: string; policy: string }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      name: "demo",
      color: "blue",
      policy: "ask",
    });
  });
});

describe("POST /sessions/:id/policy", () => {
  it("updates policy on an existing session", async () => {
    const { app, server } = await buildApp();
    const start = await server.callTool("start", { name: "s" });
    if (!start.ok) throw new Error("start failed");
    const id = (start.result as { sessionId: SessionId }).sessionId;

    const res = await app.request(`/sessions/${id}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "act" }),
    });
    expect(res.status).toBe(200);
    expect(server.sessions.get(id)?.policy).toBe("act");
  });

  it("400 on invalid policy", async () => {
    const { app, server } = await buildApp();
    const start = await server.callTool("start", { name: "s" });
    if (!start.ok) throw new Error("start failed");
    const id = (start.result as { sessionId: SessionId }).sessionId;

    const res = await app.request(`/sessions/${id}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 on unknown session", async () => {
    const { app } = await buildApp();
    const res = await app.request("/sessions/missing-id/policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "ask" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("/global-policy", () => {
  it("GET returns null by default", async () => {
    const { app } = await buildApp();
    const res = await app.request("/global-policy");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: null });
  });

  it("POST sets the global policy and GET reflects it", async () => {
    const { app, server } = await buildApp();
    const res = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "act" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: "act" });
    expect(server.policy.getGlobalPolicy()).toBe("act");

    const read = await app.request("/global-policy");
    expect(await read.json()).toEqual({ policy: "act" });
  });

  it("POST null clears the override", async () => {
    const { app, server } = await buildApp();
    server.policy.setGlobalPolicy("ask");
    const res = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: null }),
    });
    expect(res.status).toBe(200);
    expect(server.policy.getGlobalPolicy()).toBeNull();
  });

  it("env-locked: POST does NOT overwrite the pinned policy (panel cache can't clobber env)", async () => {
    const registry = new SessionRegistry();
    const policy = new PolicyStore(registry);
    const server = createBrowserMcpServer({
      bridge: stubBridge(),
      sessionRegistry: registry,
      policyStore: policy,
    });
    server.policy.setGlobalPolicy("ask"); // env-pinned value
    const app = new Hono();
    app.route("/global-policy", createGlobalPolicyRouter(server, undefined, /* envLocked */ true));

    const res = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "act" }), // panel's stale cache
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: "ask", locked: true });
    expect(server.policy.getGlobalPolicy()).toBe("ask"); // unchanged
    // GET also advertises the lock.
    expect(await (await app.request("/global-policy")).json()).toEqual({ policy: "ask", locked: true });
  });

  it("POST 400s on unknown policy strings", async () => {
    const { app } = await buildApp();
    const res = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "yolo" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("applyGlobalPolicyFromEnv", () => {
  it("sets a valid FN_BROWSER_GLOBAL_POLICY on the store", async () => {
    const { server } = await buildApp();
    const outcome = applyGlobalPolicyFromEnv(server, { FN_BROWSER_GLOBAL_POLICY: "act" });
    expect(outcome).toEqual({ applied: "act" });
    expect(server.policy.getGlobalPolicy()).toBe("act");
  });

  it("ignores an invalid value and leaves the store untouched", async () => {
    const { server } = await buildApp();
    const outcome = applyGlobalPolicyFromEnv(server, { FN_BROWSER_GLOBAL_POLICY: "yolo" });
    expect(outcome).toEqual({ ignored: "yolo" });
    expect(server.policy.getGlobalPolicy()).toBeNull();
  });

  it("is a no-op when the env var is unset", async () => {
    const { server } = await buildApp();
    const outcome = applyGlobalPolicyFromEnv(server, {});
    expect(outcome).toBeNull();
    expect(server.policy.getGlobalPolicy()).toBeNull();
  });
});

describe("global-policy change attribution", () => {
  it("invokes onChange with the new policy, principal id, and previous value", async () => {
    const registry = new SessionRegistry();
    const policy = new PolicyStore(registry);
    const server = createBrowserMcpServer({ bridge: stubBridge(), sessionRegistry: registry, policyStore: policy });
    const calls: Array<{ policy: string | null; principalId: string; previous: string | null }> = [];
    const app = new Hono();
    app.route(
      "/global-policy",
      createGlobalPolicyRouter(server, (p, principalId, previous) =>
        calls.push({ policy: p, principalId, previous }),
      ),
    );

    await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "act" }),
    });
    expect(calls).toEqual([{ policy: "act", principalId: "local", previous: null }]);
  });
});
