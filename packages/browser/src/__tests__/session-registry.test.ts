import { describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "../mcp/session-registry.js";
import type { TransportBridge, ToolResult } from "../mcp/index.js";
import type { SessionId, TabId } from "../cdp/types.js";

/** A session's group is created lazily from its first tab, so `start` never
 * touches the bridge. This stub only answers the `end` round-trip. */
function stubBridge(): TransportBridge {
  return {
    isConnected: true,
    async sendToExtension(method, params): Promise<ToolResult> {
      if (method === "__internal_end_session_group") {
        return { ok: true, result: { closed: (params.tabIds as number[]).length } };
      }
      return { ok: true, result: null };
    },
  };
}

const tab = (n: number) => n as unknown as TabId;

describe("SessionRegistry", () => {
  it("creates a session with no tab group until the first tab binds one", () => {
    const r = new SessionRegistry();
    const session = r.start({ name: "s1", color: "blue" });
    expect(session.id).toMatch(/[0-9a-f-]+/);
    expect(session.color).toBe("blue");
    expect(session.tabGroupId).toBeNull();
    expect(session.windowId).toBeNull();
    expect(r.list()).toHaveLength(1);

    r.bindTabGroup(session.id, 321, 9);
    expect(r.get(session.id)?.tabGroupId).toBe(321);
    expect(r.get(session.id)?.windowId).toBe(9);
  });

  it("bindTabGroup is idempotent for the same group, rejects a different one, and no-ops a vanished session", () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "a" });
    r.bindTabGroup(s.id, 10, 1);
    expect(() => r.bindTabGroup(s.id, 10, 1)).not.toThrow();
    expect(() => r.bindTabGroup(s.id, 11, 1)).toThrow(/already bound/);
    expect(() => r.bindTabGroup("missing" as SessionId, 99, 1)).not.toThrow();
  });

  it("rejects cross-session tab access until adopted", () => {
    const r = new SessionRegistry();
    const a = r.start({ name: "a" });
    const b = r.start({ name: "b" });

    r.attachTab(a.id, tab(7));

    const checkByOwner = r.checkTabOwnership(tab(7), a.id);
    expect(checkByOwner.allowed).toBe(true);

    const checkByIntruder = r.checkTabOwnership(tab(7), b.id);
    expect(checkByIntruder.allowed).toBe(false);
    expect(checkByIntruder.ownerSessionId).toBe(a.id);
  });

  it("treats tabs outside any session's group as user tabs (no access)", () => {
    const r = new SessionRegistry();
    const a = r.start({ name: "a" });

    const orphan = r.checkTabOwnership(tab(99), a.id);
    expect(orphan.allowed).toBe(false);
    expect(orphan.reason).toMatch(/not owned/);
  });

  it("reconcileTabGroupChange handles manual user drag between groups", () => {
    const r = new SessionRegistry();
    const a = r.start({ name: "a" });
    const b = r.start({ name: "b" });
    r.bindTabGroup(a.id, 10, 1);
    r.bindTabGroup(b.id, 20, 1);

    r.attachTab(a.id, tab(5));
    expect(r.checkTabOwnership(tab(5), a.id).allowed).toBe(true);
    expect(r.checkTabOwnership(tab(5), b.id).allowed).toBe(false);

    // Simulate user dragging tab 5 into session b's group.
    r.reconcileTabGroupChange(tab(5), 20);

    expect(r.checkTabOwnership(tab(5), a.id).allowed).toBe(false);
    expect(r.checkTabOwnership(tab(5), b.id).allowed).toBe(true);
  });

  it("reconcileTabGroupChange to an unowned group detaches ownership", () => {
    const r = new SessionRegistry();
    const a = r.start({ name: "a" });
    r.bindTabGroup(a.id, 10, 1);
    r.attachTab(a.id, tab(5));

    r.reconcileTabGroupChange(tab(5), 999); // group not known to any session

    const c = r.checkTabOwnership(tab(5), a.id);
    expect(c.allowed).toBe(false);
    expect(c.reason).toMatch(/user tab|not owned/);
  });

  it("end() closes the group and detaches its tabs", async () => {
    const r = new SessionRegistry();
    const bridge = stubBridge();
    const s = r.start({ name: "a" });
    r.bindTabGroup(s.id, 50, 1);
    r.attachTab(s.id, tab(42));
    expect(r.list()).toHaveLength(1);

    await r.end({ sessionId: s.id, bridge });

    expect(r.list()).toHaveLength(0);
    expect(r.checkTabOwnership(tab(42), s.id).allowed).toBe(false);
  });

  it("end() on a never-tabbed session makes no extension call", async () => {
    const r = new SessionRegistry();
    let endCalled = false;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method): Promise<ToolResult> {
        if (method === "__internal_end_session_group") endCalled = true;
        return { ok: true, result: null };
      },
    };
    const s = r.start({ name: "a" });
    const res = await r.end({ sessionId: s.id, bridge });
    expect(res.closedTabs).toBe(0);
    expect(endCalled).toBe(false);
    expect(r.list()).toHaveLength(0);
  });

  it("pruneIdle removes sessions past the timeout", () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "idle" });
    // Fake far-past heartbeat.
    (s as { lastHeartbeat: Date }).lastHeartbeat = new Date(Date.now() - 60 * 60 * 1000);

    const pruned = r.pruneIdle(new Date(Date.now() + 60 * 1000));
    expect(pruned).toContain(s.id);
    expect(r.list()).toHaveLength(0);
  });

  it("honors a custom idleTimeoutMs so remote-agent sessions aren't reaped mid-gap", () => {
    vi.useFakeTimers();
    try {
      const r = new SessionRegistry(undefined, undefined, 90 * 60 * 1000); // 90m window
      const s = r.start({ name: "remote" });
      vi.advanceTimersByTime(60 * 60 * 1000); // +60m: past the 30m default, under 90m
      expect(r.pruneIdle()).not.toContain(s.id); // spared (default would have reaped)
      vi.advanceTimersByTime(31 * 60 * 1000); // +91m: past the custom window
      expect(r.pruneIdle()).toContain(s.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables idle reaping when idleTimeoutMs is zero", () => {
    const r = new SessionRegistry(undefined, undefined, 0);
    const s = r.start({ name: "long-lived" });
    (s as { lastHeartbeat: Date }).lastHeartbeat = new Date(0);

    expect(r.pruneIdle(new Date("2100-01-01T00:00:00.000Z"))).toEqual([]);
    expect(r.has(s.id)).toBe(true);
  });

  it("setPolicy updates only the targeted session", () => {
    const r = new SessionRegistry();
    const a = r.start({ name: "a" });
    const b = r.start({ name: "b" });
    r.setPolicy(a.id, "act");
    expect(r.get(a.id)?.policy).toBe("act");
    expect(r.get(b.id)?.policy).toBe("ask");
  });

  it("get() refreshes lastHeartbeat", async () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "s" });
    const t0 = s.lastHeartbeat.getTime();
    await new Promise((res) => setTimeout(res, 5));
    const refreshed = r.get(s.id);
    expect(refreshed!.lastHeartbeat.getTime()).toBeGreaterThan(t0);
  });

  it("start with no color cycles through default palette", () => {
    const r = new SessionRegistry();
    const colors: string[] = [];
    for (let i = 0; i < 3; i++) {
      colors.push(r.start({ name: `s${i}` }).color);
    }
    expect(new Set(colors).size).toBe(3);
  });
});

describe("SessionRegistry teardown + reconcile safety", () => {
  it("rejects tab ownership for a session that is closing", async () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "a" });
    r.attachTab(s.id, tab(7));
    expect(r.checkTabOwnership(tab(7), s.id).allowed).toBe(true);

    // end() flips `closing` synchronously, before it awaits extension teardown.
    const ending = r.end({ sessionId: s.id, bridge: stubBridge() });
    expect(r.checkTabOwnership(tab(7), s.id).allowed).toBe(false);
    await ending;
  });

  it("touch() refreshes the idle clock so an active session is spared the reaper", () => {
    vi.useFakeTimers();
    try {
      const r = new SessionRegistry();
      const s = r.start({ name: "a" }); // heartbeat = T0
      vi.advanceTimersByTime(25 * 60 * 1000); // +25m
      r.touch(s.id); // refresh → heartbeat = T0+25m
      vi.advanceTimersByTime(20 * 60 * 1000); // +20m (20m since touch < 30m timeout)
      expect(r.pruneIdle()).not.toContain(s.id); // spared
      // Without further activity, it eventually crosses the idle timeout.
      vi.advanceTimersByTime(31 * 60 * 1000);
      expect(r.pruneIdle()).toContain(s.id); // reaped
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reap a session with a command in flight", () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "a" });
    r.beginRequest(s.id);
    // Even far past the idle timeout, an in-flight session is spared (its
    // command could still dispatch against the tab).
    expect(r.pruneIdle(new Date(Date.now() + 60 * 60 * 1000))).not.toContain(s.id);
    r.endRequest(s.id);
    // Once nothing is in flight, an idle session is reaped.
    expect(r.pruneIdle(new Date(Date.now() + 60 * 60 * 1000))).toContain(s.id);
  });

  it("fires onSessionRemoved on end() and on pruneIdle (policy GC hook)", async () => {
    const r = new SessionRegistry();
    const removed: string[] = [];
    r.onSessionRemoved = (id) => removed.push(id);

    const s1 = r.start({ name: "a" });
    await r.end({ sessionId: s1.id, bridge: stubBridge() });
    expect(removed).toContain(s1.id);

    const s2 = r.start({ name: "b" });
    // Prune with a far-future clock so s2 is past the idle cutoff.
    const pruned = r.pruneIdle(new Date(Date.now() + 60 * 60 * 1000));
    expect(pruned).toContain(s2.id);
    expect(removed).toContain(s2.id);
  });

  it("isTabSessionClosing tracks a tab whose session is tearing down", async () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "a" });
    r.bindTabGroup(s.id, 100, 1);
    r.attachTab(s.id, tab(7));
    expect(r.isTabSessionClosing(tab(7))).toBe(false);

    // Block teardown so `closing` persists across the assertion.
    let release!: () => void;
    const blockingBridge = {
      isConnected: true,
      sendToExtension: () =>
        new Promise((res) => {
          release = () => res({ ok: true, result: null });
        }),
    } as unknown as TransportBridge;
    const ending = r.end({ sessionId: s.id, bridge: blockingBridge });
    // `closing` is set synchronously, before teardown is awaited.
    expect(r.isTabSessionClosing(tab(7))).toBe(true);
    // Let the exclusive lock dispatch the (blocking) teardown bridge call.
    await new Promise((res) => setTimeout(res, 0));
    expect(r.isTabSessionClosing(tab(7))).toBe(true);
    release();
    await ending;
    // Session GC'd -> tab no longer owned -> not closing.
    expect(r.isTabSessionClosing(tab(7))).toBe(false);
  });

  it("rejects an invalid group color at start", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const server = createBrowserMcpServer({ bridge: stubBridge(), sessionRegistry: new SessionRegistry() });
    const bad = await server.callTool("start", { color: "neon" }, {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid_argument");
    const ok = await server.callTool("start", { color: "blue" }, {});
    expect(ok.ok).toBe(true);
  });

  it("serializes end() after an in-flight session op (no orphan-tab interleave)", async () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "a" });
    r.bindTabGroup(s.id, 100, 1);
    const order: string[] = [];
    // A create/adopt-like op holds the per-session lifecycle lock.
    const op = r.runSessionExclusive(s.id, async () => {
      order.push("op-start");
      await new Promise((res) => setTimeout(res, 10));
      order.push("op-end");
    });
    const ending = r
      .end({ sessionId: s.id, bridge: stubBridge() })
      .then(() => order.push("end-done"));
    await Promise.all([op, ending]);
    // end() ran only AFTER the in-flight op completed.
    expect(order).toEqual(["op-start", "op-end", "end-done"]);
  });

  it("keeps the session retriable when teardown returns !ok (closing reset, not GC'd)", async () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "a" });
    r.bindTabGroup(s.id, 100, 1);
    r.attachTab(s.id, tab(7));
    const failingBridge = {
      isConnected: true,
      async sendToExtension() {
        return { ok: false as const, error: { code: "x", message: "boom" } };
      },
    } as unknown as TransportBridge;
    await expect(r.end({ sessionId: s.id, bridge: failingBridge })).rejects.toThrow(
      /failed to close tab group/,
    );
    // The Chrome group is likely still open, so the session stays retriable:
    // `closing` is reset (ops not wedged) and ownership is intact so the caller
    // can retry end({on_tabs:"close"}). The idle reaper backstops abandonment.
    expect(r.get(s.id)?.closing).toBe(false);
    expect(r.checkTabOwnership(tab(7), s.id).allowed).toBe(true);
  });

  it("keeps the session retriable when the bridge THROWS during teardown", async () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "a" });
    r.bindTabGroup(s.id, 100, 1);
    r.attachTab(s.id, tab(8));
    const throwingBridge = {
      isConnected: true,
      async sendToExtension(): Promise<never> {
        throw new Error("transport exploded");
      },
    } as unknown as TransportBridge;
    await expect(r.end({ sessionId: s.id, bridge: throwingBridge })).rejects.toThrow(
      /transport exploded/,
    );
    // A thrown bridge call previously skipped cleanup AND left closing=true
    // (wedged forever). The catch now resets closing so the session recovers.
    expect(r.get(s.id)?.closing).toBe(false);
  });

  it("caps sessions globally and per owner", () => {
    const perOwner = new SessionRegistry(100, 2);
    perOwner.start({ ownerPrincipalId: "alice" });
    perOwner.start({ ownerPrincipalId: "alice" });
    expect(() => perOwner.start({ ownerPrincipalId: "alice" })).toThrow(/limit reached for principal/);
    expect(() => perOwner.start({ ownerPrincipalId: "bob" })).not.toThrow();

    const global = new SessionRegistry(2);
    global.start({});
    global.start({});
    expect(() => global.start({})).toThrow(/session limit reached/);
  });

  it("ignores the sentinel tabId -1 from group-level events", () => {
    const r = new SessionRegistry();
    const s = r.start({ name: "a" });
    r.bindTabGroup(s.id, 100, 1);
    r.reconcileTabGroupChange(tab(-1), 100);
    expect(r.get(s.id)?.ownedTabs.has(tab(-1))).toBe(false);
    expect(r.get(s.id)?.ownedTabs.size).toBe(0);
  });
});

describe("createBrowserMcpServer session gating", () => {
  it("gates extension-backed tab ops on session ownership", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const bridge = stubBridge();
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });

    const startRes = await server.callTool("start", { name: "a" });
    expect(startRes.ok).toBe(true);
    if (!startRes.ok) throw new Error("start a failed");
    const aId = (startRes.result as { sessionId: SessionId }).sessionId;

    const startB = await server.callTool("start", { name: "b" });
    expect(startB.ok).toBe(true);
    if (!startB.ok) throw new Error("start b failed");
    const bId = (startB.result as { sessionId: SessionId }).sessionId;

    // Pretend tab 9 belongs to session a.
    registry.attachTab(aId, tab(9));

    // Calls from b against tab 9 must be denied.
    const denied = await server.callTool(
      "screenshot",
      { tabId: 9 },
      { sessionId: bId },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("cross_session_tab");

    // Calls from a against tab 9 must pass.
    const allowed = await server.callTool(
      "screenshot",
      { tabId: 9 },
      { sessionId: aId },
    );
    expect(allowed.ok).toBe(true);
  });

  it("binds sessions to their owning principal and blocks cross-principal access", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const server = createBrowserMcpServer({ bridge: stubBridge(), sessionRegistry: registry });

    const startA = await server.callTool("start", { name: "a" }, { principalId: "alice" });
    if (!startA.ok) throw new Error("start failed");
    const aId = (startA.result as { sessionId: SessionId }).sessionId;
    registry.attachTab(aId, tab(11));

    // bob cannot info or act on alice's session, even with the right id.
    const info = await server.callTool("info", {}, { sessionId: aId, principalId: "bob" });
    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.error.code).toBe("forbidden");

    const shot = await server.callTool("screenshot", { tabId: 11 }, { sessionId: aId, principalId: "bob" });
    expect(shot.ok).toBe(false);
    if (!shot.ok) expect(shot.error.code).toBe("forbidden");

    const ended = await server.callTool("end", {}, { sessionId: aId, principalId: "bob" });
    expect(ended.ok).toBe(false);

    // alice can.
    const ok = await server.callTool("info", {}, { sessionId: aId, principalId: "alice" });
    expect(ok.ok).toBe(true);
  });

  it("denies an authenticated caller access to an unowned tab without a session", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const server = createBrowserMcpServer({ bridge: stubBridge(), sessionRegistry: new SessionRegistry() });

    // Authenticated, tab 99 owned by no session, no session id: must be denied
    // — no reading user tabs by guessing an id.
    const denied = await server.callTool(
      "screenshot",
      { tabId: 99 },
      { principalId: "ci", authenticated: true },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("no_session");

    // Unauthenticated single-tenant caller may still touch an unowned tab.
    const ok = await server.callTool("screenshot", { tabId: 99 });
    expect(ok.ok).toBe(true);
  });

  it("blocks adopting a tab owned by another principal's session", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const server = createBrowserMcpServer({ bridge: stubBridge(), sessionRegistry: registry });

    const startA = await server.callTool("start", { name: "a" }, { principalId: "alice" });
    if (!startA.ok) throw new Error("start a failed");
    const aId = (startA.result as { sessionId: SessionId }).sessionId;
    registry.attachTab(aId, tab(50));

    const startB = await server.callTool("start", { name: "b" }, { principalId: "bob" });
    if (!startB.ok) throw new Error("start b failed");
    const bId = (startB.result as { sessionId: SessionId }).sessionId;

    // bob cannot adopt alice's tab (adopt_tab isn't tab-scoped, so it needs its
    // own cross-principal guard).
    const denied = await server.callTool(
      "adopt_tab",
      { tabId: 50 },
      { sessionId: bId, principalId: "bob", authenticated: true },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("cross_session_tab");
  });

  it("serializes concurrent cross-principal adopt of the same unowned tab (bridge once)", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    let adoptSends = 0;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method): Promise<ToolResult> {
        if (method === "__internal_request_consent") return { ok: true, result: { choice: "allow" } };
        if (method === "adopt_tab") {
          adoptSends++;
          return { ok: true, result: { id: 77, groupId: 500, windowId: 1 } };
        }
        return { ok: true, result: null };
      },
    };
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });
    const a = await server.callTool("start", { name: "a" }, { principalId: "alice" });
    const b = await server.callTool("start", { name: "b" }, { principalId: "bob" });
    if (!a.ok || !b.ok) throw new Error("start failed");
    const aId = (a.result as { sessionId: SessionId }).sessionId;
    const bId = (b.result as { sessionId: SessionId }).sessionId;

    const [ra, rb] = await Promise.all([
      server.callTool("adopt_tab", { tabId: 77 }, { sessionId: aId, principalId: "alice", authenticated: true }),
      server.callTool("adopt_tab", { tabId: 77 }, { sessionId: bId, principalId: "bob", authenticated: true }),
    ]);

    const results = [ra, rb];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === "cross_session_tab")).toHaveLength(1);
    expect(adoptSends).toBe(1); // the loser denied BEFORE moving the Chrome tab
  });

  it("list_sessions shows a principal only its own sessions", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const server = createBrowserMcpServer({ bridge: stubBridge(), sessionRegistry: registry });
    await server.callTool("start", { name: "a" }, { principalId: "alice" });
    await server.callTool("start", { name: "b" }, { principalId: "bob" });

    const list = await server.callTool("list_sessions", {}, { principalId: "alice" });
    if (!list.ok) throw new Error("list failed");
    const names = (list.result as { sessions: Array<{ name: string }> }).sessions.map((s) => s.name);
    expect(names).toEqual(["a"]);

    // An admin/operator principal sees ALL sessions (matches the /sessions route).
    const adminList = await server.callTool(
      "list_sessions",
      {},
      { principalId: "ops", isAdmin: true },
    );
    if (!adminList.ok) throw new Error("admin list failed");
    const adminNames = (adminList.result as { sessions: Array<{ name: string }> }).sessions
      .map((s) => s.name)
      .sort();
    expect(adminNames).toEqual(["a", "b"]);
  });

  it("rejects the removed scope:'cross_session' bypass", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const server = createBrowserMcpServer({ bridge: stubBridge(), sessionRegistry: registry });

    const startA = await server.callTool("start", { name: "a" });
    if (!startA.ok) throw new Error("start a failed");
    const aId = (startA.result as { sessionId: SessionId }).sessionId;
    const startB = await server.callTool("start", { name: "b" });
    if (!startB.ok) throw new Error("start b failed");
    const bId = (startB.result as { sessionId: SessionId }).sessionId;

    registry.attachTab(aId, tab(9));

    // The old escape hatch — passing scope:"cross_session" — must no longer
    // bypass ownership; b is still denied.
    const denied = await server.callTool(
      "screenshot",
      { tabId: 9, scope: "cross_session" },
      { sessionId: bId },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("cross_session_tab");
      expect(denied.error.message).not.toMatch(/cross_session/);
    }
  });

  it("falls back to unchecked routing when no sessionId is provided", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const bridge = stubBridge();
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });

    // No session context and no known owner: direct user-tab tools still work.
    const r = await server.callTool("screenshot", { tabId: 42 });
    expect(r.ok).toBe(true);
  });

  it("rejects access to session-owned tabs when session context is missing", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const bridge = stubBridge();
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });

    const start = await server.callTool("start", { name: "s" });
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error("start failed");
    const sessionId = (start.result as { sessionId: SessionId }).sessionId;
    registry.attachTab(sessionId, tab(42));

    const r = await server.callTool("screenshot", { tabId: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("no_session");
  });

  it("rejects 'info' when the header session is unknown", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const server = createBrowserMcpServer({ bridge: stubBridge() });
    const r = await server.callTool("info", {}, { sessionId: "bogus" as SessionId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("no_session");
  });

  it("uses sessionId tool arguments for info and end when headers are unavailable", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const server = createBrowserMcpServer({ bridge: stubBridge(), sessionRegistry: registry });

    const start = await server.callTool("start", { name: "s" });
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error("start failed");
    const sessionId = (start.result as { sessionId: SessionId }).sessionId;

    const info = await server.callTool("info", { sessionId });
    expect(info.ok).toBe(true);
    if (!info.ok) throw new Error("info failed");
    expect((info.result as { sessionId: SessionId }).sessionId).toBe(sessionId);

    const end = await server.callTool("end", { sessionId });
    expect(end.ok).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("first create_tab creates and binds the session group; second reuses it", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const createParams: Array<Record<string, unknown>> = [];
    let nextTabId = 88;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method, params): Promise<ToolResult> {
        if (method === "create_tab") {
          createParams.push(params);
          // Extension always reports the tab in group 321 (created on first call,
          // joined thereafter).
          return {
            ok: true,
            result: { id: nextTabId++, url: params.url, title: "", windowId: 9, groupId: 321, active: true },
          };
        }
        return { ok: true, result: null };
      },
    };
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });

    const start = await server.callTool("start", { name: "s", color: "blue" });
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error("start failed");
    const sessionId = (start.result as { sessionId: SessionId }).sessionId;
    expect(registry.get(sessionId)?.tabGroupId).toBeNull();

    const first = await server.callTool("create_tab", { sessionId, url: "https://example.com" });
    expect(first.ok).toBe(true);
    // First tab forwards a create-group instruction, not a group id.
    expect(createParams[0]).toMatchObject({
      url: "https://example.com",
      group: { create: { name: "s", color: "blue" } },
    });
    expect(createParams[0]).not.toHaveProperty("sessionId");
    expect(registry.get(sessionId)?.tabGroupId).toBe(321);
    expect(registry.get(sessionId)?.windowId).toBe(9);
    expect(registry.checkTabOwnership(tab(88), sessionId).allowed).toBe(true);

    const second = await server.callTool("create_tab", { sessionId, url: "https://example.org" });
    expect(second.ok).toBe(true);
    // Second tab joins the existing group.
    expect(createParams[1]).toMatchObject({
      url: "https://example.org",
      windowId: 9,
      group: { id: 321 },
    });
    expect(registry.checkTabOwnership(tab(89), sessionId).allowed).toBe(true);
  });

  it("rejects a first tab the extension failed to group (groupId -1)", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method, params): Promise<ToolResult> {
        if (method === "create_tab") {
          return {
            ok: true,
            result: { id: 7, url: params.url, title: "", windowId: 2, groupId: -1, active: true },
          };
        }
        return { ok: true, result: null };
      },
    };
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });

    const start = await server.callTool("start", { name: "s" });
    if (!start.ok) throw new Error("start failed");
    const sessionId = (start.result as { sessionId: SessionId }).sessionId;

    const r = await server.callTool("create_tab", { sessionId, url: "https://x.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("session_group_not_created");
    expect(registry.get(sessionId)?.tabGroupId).toBeNull();
  });

  it("serializes concurrent first-tab calls so exactly one group is created", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const registry = new SessionRegistry();
    const groups: Array<{ id?: number; create?: unknown }> = [];
    let nextGroupId = 500;
    let nextTabId = 1;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method, params): Promise<ToolResult> {
        if (method === "create_tab") {
          const group = params.group as { id?: number; create?: unknown };
          groups.push(group);
          const groupId = "create" in group ? nextGroupId++ : 500;
          await Promise.resolve(); // yield so the two calls genuinely interleave
          return {
            ok: true,
            result: { id: nextTabId++, url: params.url, title: "", windowId: 1, groupId, active: true },
          };
        }
        return { ok: true, result: null };
      },
    };
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });

    const start = await server.callTool("start", { name: "s" });
    if (!start.ok) throw new Error("start failed");
    const sessionId = (start.result as { sessionId: SessionId }).sessionId;

    const [r1, r2] = await Promise.all([
      server.callTool("create_tab", { sessionId, url: "https://a.com" }),
      server.callTool("create_tab", { sessionId, url: "https://b.com" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(registry.get(sessionId)?.tabGroupId).toBe(500);
    // Exactly one create-group instruction, one join.
    expect(groups.filter((g) => "create" in g)).toHaveLength(1);
    expect(groups.filter((g) => "id" in g)).toHaveLength(1);
  });

  it("rejects create_tab without an explicit session", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const server = createBrowserMcpServer({
      bridge: stubBridge(),
      sessionRegistry: new SessionRegistry(),
    });

    const created = await server.callTool("create_tab", { url: "https://example.com" });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe("no_session");
  });

  it("list_tabs returns [] without a bridge call when the session has no tab yet", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    let listCalled = false;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method): Promise<ToolResult> {
        if (method === "list_tabs") listCalled = true;
        return { ok: true, result: [] };
      },
    };
    const server = createBrowserMcpServer({ bridge, sessionRegistry: new SessionRegistry() });

    const start = await server.callTool("start", { name: "s" });
    if (!start.ok) throw new Error("start failed");
    const sessionId = (start.result as { sessionId: SessionId }).sessionId;

    const listed = await server.callTool("list_tabs", { sessionId });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.result).toEqual([]);
    expect(listCalled).toBe(false);
  });

  it("list_tabs scopes to the caller session group once a tab exists", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    let listParams: Record<string, unknown> | undefined;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method, params): Promise<ToolResult> {
        if (method === "create_tab") {
          return {
            ok: true,
            result: { id: 5, url: params.url, title: "", windowId: 3, groupId: 456, active: true },
          };
        }
        if (method === "list_tabs") {
          listParams = params;
          return { ok: true, result: [] };
        }
        return { ok: true, result: null };
      },
    };
    const server = createBrowserMcpServer({ bridge, sessionRegistry: new SessionRegistry() });

    const start = await server.callTool("start", { name: "s" });
    if (!start.ok) throw new Error("start failed");
    const sessionId = (start.result as { sessionId: SessionId }).sessionId;
    await server.callTool("create_tab", { sessionId, url: "https://example.com" });

    const listed = await server.callTool("list_tabs", { sessionId });
    expect(listed.ok).toBe(true);
    expect(listParams).toEqual({ groupId: 456, windowId: 3 });
  });

  it("list_tabs scope=all is explicitly consent-gated", async () => {
    const { createBrowserMcpServer } = await import("../mcp/index.js");
    const calls: string[] = [];
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method, params): Promise<ToolResult> {
        calls.push(method);
        if (method === "__internal_request_consent") {
          expect(params).toMatchObject({ title: "List all browser tabs" });
          return { ok: true, result: { choice: "allow" } };
        }
        if (method === "list_tabs") {
          expect(params).toEqual({});
          return { ok: true, result: [] };
        }
        return { ok: true, result: null };
      },
    };
    const server = createBrowserMcpServer({ bridge });

    const listed = await server.callTool("list_tabs", { scope: "all" });
    expect(listed.ok).toBe(true);
    expect(calls).toEqual(["__internal_request_consent", "list_tabs"]);
  });
});
