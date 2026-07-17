import { describe, expect, it } from "vitest";

import {
  createBrowserMcpServer,
  REMOTE_ORIGIN_POLICY,
  type TransportBridge,
  type ToolResult,
  TOOLS,
} from "../mcp/index.js";
import { PolicyStore } from "../mcp/policy-store.js";
import { SessionRegistry } from "../mcp/session-registry.js";
import type { SessionId, TabId } from "../cdp/types.js";

function stubBridge(
  handler?: (method: string, params: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
): TransportBridge {
  return {
    isConnected: true,
    async sendToExtension(method, params): Promise<ToolResult> {
      if (!handler) return { ok: true, result: { method, params } };
      return handler(method, params);
    },
  };
}

describe("createBrowserMcpServer", () => {
  it("exposes the full tool catalog", () => {
    const server = createBrowserMcpServer({ bridge: stubBridge() });
    const names = new Set(server.tools.map((t) => t.name));
    expect(names.has("upload_file")).toBe(true);
    expect(names.has("navigate")).toBe(true);
    expect(names.has("observe")).toBe(true);
    expect(names.has("rate_limit_check")).toBe(true);
    expect(names.has("require_consent")).toBe(true);
    expect(names.has("start")).toBe(true);
    expect(names.has("list_sessions")).toBe(true);
    // Spot-check completeness
    expect(server.tools.length).toBe(TOOLS.length);
  });

  it("rejects unknown tools cleanly", async () => {
    const server = createBrowserMcpServer({ bridge: stubBridge() });
    const r = await server.callTool("nope", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unknown_tool");
  });

  it("forwards navigate with a bridge timeout above its own deadline", async () => {
    let captured: { method: string; options?: { timeoutMs?: number } } | null = null;
    const server = createBrowserMcpServer({
      bridge: {
        isConnected: true,
        async sendToExtension(method, _params, options): Promise<ToolResult> {
          captured = { method, options };
          return { ok: true, result: null };
        },
      },
    });

    await server.callTool("navigate", { url: "https://example.com" });
    expect(captured!.method).toBe("navigate");
    expect(captured!.options?.timeoutMs).toBeGreaterThanOrEqual(30_000);

    // evaluate_js awaits page promises — keep the longer (60s) default so the
    // lowered host backstop doesn't fail slow-but-valid scripts.
    captured = null;
    await server.callTool("evaluate_js", { tabId: 1, expression: "1" });
    expect(captured!.method).toBe("evaluate_js");
    expect(captured!.options?.timeoutMs).toBeGreaterThanOrEqual(60_000);

    captured = null;
    await server.callTool("read_page", { tabId: 1 });
    expect(captured!.options).toBeUndefined();
  });

  it("forces a real consent prompt to adopt an unowned user tab in authenticated mode (act can't auto-approve)", async () => {
    const sessions = new SessionRegistry();
    const policy = new PolicyStore();
    policy.setGlobalPolicy("act"); // auto-approves NON-destructive ops
    let consentPrompts = 0;
    let consentParams: Record<string, unknown> | undefined;
    const bridge = stubBridge((method, params) => {
      if (method === "__internal_request_consent") {
        consentPrompts++;
        consentParams = params;
        return { ok: true, result: { choice: "deny" } };
      }
      return { ok: true, result: { id: 999, groupId: 1, windowId: 1 } };
    });
    const server = createBrowserMcpServer({ bridge, policyStore: policy, sessionRegistry: sessions });
    const start = await server.callTool("start", { name: "a" }, { principalId: "alice" });
    if (!start.ok) throw new Error("start failed");
    const sid = (start.result as { sessionId: SessionId }).sessionId;

    // Tab 999 is unowned (a user tab). An authenticated adopt MUST prompt despite
    // the act policy — otherwise a remote token silently steals the user's tab.
    const res = await server.callTool(
      "adopt_tab",
      { tabId: 999 },
      { sessionId: sid, principalId: "alice", authenticated: true },
    );
    expect(consentPrompts).toBe(1); // prompted, not auto-approved
    // tabId is omitted so the extension can't auto-approve via the per-origin allowlist.
    expect(consentParams?.tabId).toBeUndefined();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("consent_denied");
  });

  it("re-checks tab ownership after the consent await (tab un-owned mid-prompt)", async () => {
    const sessions = new SessionRegistry();
    const policy = new PolicyStore(sessions);
    const bridge = stubBridge((method) => {
      if (method === "__internal_request_consent") {
        // Simulate a concurrent end()/un-own during the prompt: move the tab to
        // an unowned group so it leaves the caller's session.
        sessions.reconcileTabGroupChange(7 as unknown as TabId, 999);
        return { ok: true, result: { choice: "allow" } };
      }
      return { ok: true, result: { ok: true } };
    });
    const server = createBrowserMcpServer({ bridge, policyStore: policy, sessionRegistry: sessions });
    const start = await server.callTool("start", { name: "a" }, { principalId: "alice" });
    if (!start.ok) throw new Error("start failed");
    const sid = (start.result as { sessionId: SessionId }).sessionId;
    sessions.bindTabGroup(sid, 100, 1);
    sessions.attachTab(sid, 7 as unknown as TabId);

    // Destructive click waits for consent; the prompt un-owns the tab; the
    // post-consent re-check must reject instead of acting on a now-unowned tab.
    const res = await server.callTool(
      "click",
      { tabId: 7, destructive: true, sessionId: sid },
      { sessionId: sid, principalId: "alice", authenticated: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("cross_session_tab");
  });

  it("holds the session in-flight during a tabless create_tab so the reaper can't prune it", async () => {
    const sessions = new SessionRegistry();
    let release!: () => void;
    const bridge = stubBridge((method) => {
      if (method === "create_tab") {
        return new Promise<ToolResult>((res) => {
          release = () => res({ ok: true, result: { id: 5, groupId: 9, windowId: 1 } });
        });
      }
      return { ok: true, result: { ok: true } };
    });
    const server = createBrowserMcpServer({ bridge, sessionRegistry: sessions });
    const start = await server.callTool("start", { name: "a" }, {});
    if (!start.ok) throw new Error("start failed");
    const sid = (start.result as { sessionId: SessionId }).sessionId;

    // create_tab is tabless (no tabId yet) — without in-flight tracking the
    // reaper could prune the session before bindTabGroup/attachTab run.
    const pending = server.callTool("create_tab", { url: "https://x.com", sessionId: sid }, { sessionId: sid });
    await Promise.resolve();
    expect(sessions.pruneIdle(new Date(Date.now() + 60 * 60 * 1000))).not.toContain(sid);
    release();
    await pending;
  });

  it("passes tool args to the authorize hook so arg-scoped rules apply (incl. inner flow calls)", async () => {
    const server = createBrowserMcpServer({ bridge: stubBridge() });
    // Arg-aware deny: only list_tabs with scope:"all" is forbidden.
    const authorize = (t: string, a: Record<string, unknown>) =>
      !(t === "list_tabs" && a?.scope === "all");

    const denied = await server.callTool("list_tabs", { scope: "all" }, { authorize });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");

    // Session-scoped passes the authorize gate (not a 'forbidden' from authz).
    const allowed = await server.callTool("list_tabs", { scope: "session" }, { authorize });
    expect(allowed.ok === false && allowed.error.code === "forbidden").toBe(false);
  });

  it("blocks navigation to private hosts under a remote origin policy", async () => {
    let forwarded = false;
    const server = createBrowserMcpServer({
      bridge: stubBridge(async () => {
        forwarded = true;
        return { ok: true, result: null };
      }),
      originPolicy: REMOTE_ORIGIN_POLICY,
    });
    const blocked = await server.callTool("navigate", { url: "http://169.254.169.254/latest/" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("navigation_blocked");
    expect(forwarded).toBe(false); // never reached the bridge

    const ok = await server.callTool("navigate", { url: "https://example.com" });
    expect(ok.ok).toBe(true);
    expect(forwarded).toBe(true);
  });

  it("routes extension tools to the bridge", async () => {
    let captured: { method: string; params: Record<string, unknown> } | null = null;
    const server = createBrowserMcpServer({
      bridge: stubBridge(async (method, params) => {
        captured = { method, params };
        return { ok: true, result: { ok: true, path: "/x.pdf", selector: "input" } };
      }),
    });
    const r = await server.callTool("upload_file", {
      tabId: 7,
      selector: "input[type=file]",
      path: "/x.pdf",
    });
    expect(r.ok).toBe(true);
    expect(captured).toEqual({
      method: "upload_file",
      params: { tabId: 7, selector: "input[type=file]", path: "/x.pdf" },
    });
  });

  it("surfaces extension_unreachable without dispatch when the bridge is disconnected", async () => {
    let called = false;
    const server = createBrowserMcpServer({
      bridge: {
        isConnected: false,
        async sendToExtension() {
          called = true;
          return {
            ok: false,
            error: {
              code: "extension_unreachable",
              message: "Extension is disconnected.",
            },
          };
        },
      },
    });
    const r = await server.callTool("navigate", { tabId: 1, url: "about:blank" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("extension_unreachable");
    expect(called).toBe(false);
  });

  it("handles rate_limit_check entirely in-host (no bridge call)", async () => {
    let bridgeCalled = false;
    const server = createBrowserMcpServer({
      bridge: stubBridge(async () => {
        bridgeCalled = true;
        return { ok: true, result: null };
      }),
    });

    const check = await server.callTool("rate_limit_check", {
      tag: "test:tag",
      max: 5,
      window: "minute",
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.result).toMatchObject({ allowed: true, remaining: 5, count: 0 });
    }

    const consume = await server.callTool("rate_limit_consume", {
      tag: "test:tag",
      max: 5,
      window: "minute",
    });
    expect(consume.ok).toBe(true);
    if (consume.ok) {
      expect(consume.result).toMatchObject({ allowed: true, remaining: 4 });
    }
    expect(bridgeCalled).toBe(false);
  });

  it("routes require_consent through the bridge and returns the user's choice", async () => {
    const server = createBrowserMcpServer({
      bridge: stubBridge(async (method) => {
        expect(method).toBe("__internal_request_consent");
        return { ok: true, result: { choice: "allow" } };
      }),
    });
    const r = await server.callTool("require_consent", {
      title: "Submit?",
      body: "Send application to company X",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toMatchObject({ choice: "allow" });
  });
});
