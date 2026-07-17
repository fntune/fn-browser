import { describe, expect, it, vi } from "vitest";

import { PolicyStore } from "../mcp/policy-store.js";
import { SessionRegistry } from "../mcp/session-registry.js";
import type { TransportBridge, ToolResult } from "../mcp/index.js";
import type { HitlMode, SessionId } from "../cdp/types.js";

function bridgeThatAnswersConsent(choice: string): TransportBridge {
  return {
    isConnected: true,
    async sendToExtension(method, params): Promise<ToolResult> {
      expect(method).toBe("__internal_request_consent");
      expect(params).toHaveProperty("title");
      return { ok: true, result: { choice } };
    },
  };
}

describe("PolicyStore.rateLimit", () => {
  it("atomic consume allows up to max then rejects (single round-trip)", async () => {
    const p = new PolicyStore();
    const c1 = await p.rateLimitConsume("t", 3, "minute");
    expect(c1.allowed).toBe(true);
    expect(c1.remaining).toBe(2);
    expect((await p.rateLimitConsume("t", 3, "minute")).remaining).toBe(1);
    expect((await p.rateLimitConsume("t", 3, "minute")).remaining).toBe(0);
    const over = await p.rateLimitConsume("t", 3, "minute");
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("over-limit consume does not increment further", async () => {
    const p = new PolicyStore();
    await p.rateLimitConsume("t", 1, "minute"); // allowed → count 1
    await p.rateLimitConsume("t", 1, "minute"); // denied → stays 1
    await p.rateLimitConsume("t", 1, "minute"); // denied → stays 1
    expect((await p.rateLimitCheck("t", 1, "minute")).count).toBe(1);
  });

  it("check is advisory — peeks without incrementing", async () => {
    const p = new PolicyStore();
    expect((await p.rateLimitCheck("t", 3, "minute")).count).toBe(0);
    expect((await p.rateLimitCheck("t", 3, "minute")).count).toBe(0);
    expect((await p.rateLimitConsume("t", 3, "minute")).remaining).toBe(2);
  });

  it("never over-consumes under concurrent consume", async () => {
    const p = new PolicyStore();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => p.rateLimitConsume("t", 3, "minute")),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it("session scope isolates budgets; global stays shared", async () => {
    const p = new PolicyStore();
    const a = await p.rateLimitConsume("t", 1, "minute", {
      scope: "session",
      sessionId: "s1" as SessionId,
    });
    const b = await p.rateLimitConsume("t", 1, "minute", {
      scope: "session",
      sessionId: "s2" as SessionId,
    });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true); // distinct session namespaces
    await p.rateLimitConsume("g", 1, "minute");
    expect((await p.rateLimitConsume("g", 1, "minute")).allowed).toBe(false);
  });

  it("session scope without a sessionId throws", async () => {
    const p = new PolicyStore();
    await expect(
      p.rateLimitConsume("t", 1, "minute", { scope: "session" }),
    ).rejects.toThrow(/requires a session id/);
  });

  it("clearSession evicts that session's counters, leaving global + other sessions intact", async () => {
    const p = new PolicyStore();
    const s1 = { scope: "session" as const, sessionId: "s1" as SessionId };
    const s2 = { scope: "session" as const, sessionId: "s2" as SessionId };
    await p.rateLimitConsume("t", 5, "minute", s1); // remaining 4
    await p.rateLimitConsume("t", 5, "minute", s1); // remaining 3
    await p.rateLimitConsume("t", 5, "minute", s2); // remaining 4
    await p.rateLimitConsume("g", 5, "minute"); // global, remaining 4

    p.clearSession("s1" as SessionId);

    // s1 evicted → a fresh counter → first consume again sees the full budget.
    expect((await p.rateLimitConsume("t", 5, "minute", s1)).remaining).toBe(4);
    // s2 untouched → continues from 4.
    expect((await p.rateLimitConsume("t", 5, "minute", s2)).remaining).toBe(3);
    // global untouched → continues from 4.
    expect((await p.rateLimitConsume("g", 5, "minute")).remaining).toBe(3);
  });

  it("session scope rejects an unregistered session id (no fresh-counter rotation)", async () => {
    const registry = new SessionRegistry();
    const p = new PolicyStore(registry);
    const s = registry.start({ name: "x" });
    // A real session id works.
    expect(
      (await p.rateLimitConsume("t", 1, "minute", { scope: "session", sessionId: s.id })).allowed,
    ).toBe(true);
    // A made-up id can't be used to mint a fresh counter.
    await expect(
      p.rateLimitConsume("t", 1, "minute", { scope: "session", sessionId: "ghost" as SessionId }),
    ).rejects.toThrow(/live session id/);
  });

  it("resets when the window actually elapses (time-based, not just map-clear)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-21T00:00:00Z"));
      const p = new PolicyStore();
      expect((await p.rateLimitConsume("t", 1, "minute")).allowed).toBe(true);
      expect((await p.rateLimitConsume("t", 1, "minute")).allowed).toBe(false);
      // Still blocked just before the 1-minute window closes.
      vi.setSystemTime(new Date("2026-06-21T00:00:59Z"));
      expect((await p.rateLimitConsume("t", 1, "minute")).allowed).toBe(false);
      // Past the window → the counter re-initializes (real resetAt elapse).
      vi.setSystemTime(new Date("2026-06-21T00:01:01Z"));
      expect((await p.rateLimitConsume("t", 1, "minute")).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on an unknown window instead of silently disabling the limit", async () => {
    const p = new PolicyStore();
    // Regression: the old "hourly" enum → windowToMs undefined → resetAt NaN →
    // the window reset every call, silently disabling the limit. Now it throws.
    await expect(p.rateLimitConsume("t", 1, "hourly")).rejects.toThrow(
      /unknown rate-limit window/,
    );
    await expect(p.rateLimitCheck("t", 1, "hourly")).rejects.toThrow(
      /unknown rate-limit window/,
    );
  });
});

describe("PolicyStore.requireConsent", () => {
  it("forwards to the bridge and returns the user's choice", async () => {
    const p = new PolicyStore();
    const result = await p.requireConsent({
      title: "Test",
      body: "body",
      bridge: bridgeThatAnswersConsent("allow"),
    });
    expect(result.choice).toBe("allow");
    expect(result.at).toBeTruthy();
  });

  it("bubbles consent errors up", async () => {
    const p = new PolicyStore();
    await expect(
      p.requireConsent({
        title: "x",
        body: "y",
        bridge: {
          isConnected: true,
          async sendToExtension(): Promise<ToolResult> {
            return { ok: false, error: { code: "cdp_timeout", message: "Command timed out after 600000ms" } };
          },
        },
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("PolicyStore.requireConsent — 3-mode × destructive matrix", () => {
  // Plan §HITL invariant: destructive always prompts; non-destructive
  // auto-allows under `act`/`follow_plan`, prompts under `ask`.
  async function bootstrap(policy: HitlMode) {
    const registry = new SessionRegistry();
    const store = new PolicyStore(registry);
    let bridgeCalls = 0;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        bridgeCalls++;
        return { ok: true, result: { choice: "allow" } };
      },
    };
    const session = registry.start({ name: "t" });
    registry.setPolicy(session.id, policy);
    return { store, bridge, sessionId: session.id, calls: () => bridgeCalls };
  }

  const matrix: Array<[HitlMode, boolean, "prompt" | "auto-allow"]> = [
    ["ask", true, "prompt"],
    ["ask", false, "prompt"],
    ["follow_plan", true, "prompt"],
    ["follow_plan", false, "auto-allow"],
    ["act", true, "prompt"],
    ["act", false, "auto-allow"],
  ];

  for (const [policy, destructive, expected] of matrix) {
    it(`${policy} + destructive=${destructive} → ${expected}`, async () => {
      const { store, bridge, sessionId, calls } = await bootstrap(policy);
      const result = await store.requireConsent({
        title: "t",
        body: "b",
        bridge,
        sessionId,
        destructive,
      });
      expect(result.choice).toBe("allow");
      if (expected === "prompt") {
        expect(calls()).toBe(1);
      } else {
        expect(calls()).toBe(0);
      }
    });
  }

  it("falls back to prompt when sessionId is missing", async () => {
    const store = new PolicyStore(new SessionRegistry());
    let bridgeCalled = false;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        bridgeCalled = true;
        return { ok: true, result: { choice: "allow" } };
      },
    };
    await store.requireConsent({ title: "t", body: "b", bridge, destructive: false });
    expect(bridgeCalled).toBe(true);
  });

  it("falls back to prompt when SessionRegistry is not wired", async () => {
    const store = new PolicyStore(); // no registry
    let bridgeCalled = false;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        bridgeCalled = true;
        return { ok: true, result: { choice: "allow" } };
      },
    };
    await store.requireConsent({
      title: "t",
      body: "b",
      bridge,
      sessionId: "fake-id" as SessionId,
      destructive: false,
    });
    expect(bridgeCalled).toBe(true);
  });
});

describe("PolicyStore global override", () => {
  async function bootstrapWithSession(sessionPolicy: HitlMode) {
    const registry = new SessionRegistry();
    const store = new PolicyStore(registry);
    let bridgeCalls = 0;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        bridgeCalls++;
        return { ok: true, result: { choice: "allow" } };
      },
    };
    const session = registry.start({ name: "t" });
    registry.setPolicy(session.id, sessionPolicy);
    return { store, bridge, sessionId: session.id, calls: () => bridgeCalls };
  }

  it("global=ask forces prompt even when session is `act`", async () => {
    const { store, bridge, sessionId, calls } =
      await bootstrapWithSession("act");
    store.setGlobalPolicy("ask");
    await store.requireConsent({
      title: "t",
      body: "b",
      bridge,
      sessionId,
      destructive: false,
    });
    expect(calls()).toBe(1);
  });

  it("global=act auto-allows non-destructive even when session is `ask`", async () => {
    const { store, bridge, sessionId, calls } =
      await bootstrapWithSession("ask");
    store.setGlobalPolicy("act");
    await store.requireConsent({
      title: "t",
      body: "b",
      bridge,
      sessionId,
      destructive: false,
    });
    expect(calls()).toBe(0);
  });

  it("global=act never auto-allows destructive — invariant holds", async () => {
    const { store, bridge, sessionId, calls } =
      await bootstrapWithSession("act");
    store.setGlobalPolicy("act");
    await store.requireConsent({
      title: "t",
      body: "b",
      bridge,
      sessionId,
      destructive: true,
    });
    expect(calls()).toBe(1);
  });

  it("clearing global (null) restores per-session behaviour", async () => {
    const { store, bridge, sessionId, calls } =
      await bootstrapWithSession("act");
    store.setGlobalPolicy("ask");
    await store.requireConsent({
      title: "t",
      body: "b",
      bridge,
      sessionId,
      destructive: false,
    });
    expect(calls()).toBe(1);

    store.setGlobalPolicy(null);
    await store.requireConsent({
      title: "t",
      body: "b",
      bridge,
      sessionId,
      destructive: false,
    });
    // session.policy === "act" short-circuited; no new bridge call.
    expect(calls()).toBe(1);
  });

  it("global=act applies even without a session context", async () => {
    const store = new PolicyStore(new SessionRegistry());
    let bridgeCalled = false;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        bridgeCalled = true;
        return { ok: true, result: { choice: "allow" } };
      },
    };
    store.setGlobalPolicy("act");
    const result = await store.requireConsent({
      title: "t",
      body: "b",
      bridge,
      destructive: false,
    });
    expect(result.choice).toBe("allow");
    expect(bridgeCalled).toBe(false);
  });

  it("getGlobalPolicy round-trips through setGlobalPolicy", () => {
    const store = new PolicyStore();
    expect(store.getGlobalPolicy()).toBeNull();
    store.setGlobalPolicy("act");
    expect(store.getGlobalPolicy()).toBe("act");
    store.setGlobalPolicy(null);
    expect(store.getGlobalPolicy()).toBeNull();
  });
});

describe("PolicyStore.snapshotRateLimits", () => {
  it("returns active counters only", async () => {
    const p = new PolicyStore();
    await p.rateLimitConsume("a", 5, "minute");
    await p.rateLimitCheck("b", 10, "daily");
    const snap = p.snapshotRateLimits();
    const byTag = Object.fromEntries(snap.map((s) => [s.tag, s]));
    expect(byTag.a?.count).toBe(1);
    expect(byTag.b?.count).toBe(0);
    expect(new Date(byTag.a!.reset_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("PolicyStore.requireTosAcceptance", () => {
  it("prompts on first call, caches for subsequent calls in the same session", async () => {
    const p = new PolicyStore();
    let calls = 0;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        calls++;
        return { ok: true, result: { choice: "accept" } };
      },
    };
    const sessionId = "s1" as SessionId;

    const first = await p.requireTosAcceptance({ origin: "linkedin.com", policyText: "...", bridge, sessionId });
    expect(first).toEqual({ accepted: true, already_accepted: false });

    const second = await p.requireTosAcceptance({ origin: "linkedin.com", policyText: "...", bridge, sessionId });
    expect(second).toEqual({ accepted: true, already_accepted: true });
    expect(calls).toBe(1);

    // A DIFFERENT session is not satisfied by s1's acceptance — re-prompts.
    const otherSession = await p.requireTosAcceptance({
      origin: "linkedin.com",
      policyText: "...",
      bridge,
      sessionId: "s2" as SessionId,
    });
    expect(otherSession.already_accepted).toBe(false);
    expect(calls).toBe(2);
  });

  it("caches ToS only under a LIVE session id (stale/unknown ids never cache)", async () => {
    const r = new SessionRegistry();
    const p = new PolicyStore(r);
    const live = r.start({ name: "a" });
    let calls = 0;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        calls++;
        return { ok: true, result: { choice: "accept" } };
      },
    };
    // Live session → cached.
    await p.requireTosAcceptance({ origin: "x.com", policyText: "...", bridge, sessionId: live.id });
    expect(
      (await p.requireTosAcceptance({ origin: "x.com", policyText: "...", bridge, sessionId: live.id }))
        .already_accepted,
    ).toBe(true);
    // Unknown/stale id (registry doesn't know it) → never cached, re-prompts,
    // and grows no bucket that onSessionRemoved would never clear.
    const ghost = "ghost" as SessionId;
    await p.requireTosAcceptance({ origin: "y.com", policyText: "...", bridge, sessionId: ghost });
    expect(
      (await p.requireTosAcceptance({ origin: "y.com", policyText: "...", bridge, sessionId: ghost }))
        .already_accepted,
    ).toBe(false);
    // x.com prompted once (2nd was cached); y.com prompted twice (never cached).
    expect(calls).toBe(3);
  });

  it("never shares ToS acceptance across no-session callers (re-prompts, no cross-principal leak)", async () => {
    const p = new PolicyStore();
    let calls = 0;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        calls++;
        return { ok: true, result: { choice: "accept" } };
      },
    };
    // No sessionId → not cached, so a second no-session caller (a different
    // principal in the daemon) does NOT inherit the first's acceptance.
    await p.requireTosAcceptance({ origin: "linkedin.com", policyText: "...", bridge });
    const second = await p.requireTosAcceptance({ origin: "linkedin.com", policyText: "...", bridge });
    expect(second).toEqual({ accepted: true, already_accepted: false });
    expect(calls).toBe(2);
  });

  it("does not cache on decline", async () => {
    const p = new PolicyStore();
    let calls = 0;
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(): Promise<ToolResult> {
        calls++;
        return { ok: true, result: { choice: "decline" } };
      },
    };

    const first = await p.requireTosAcceptance({
      origin: "linkedin.com",
      policyText: "...",
      bridge,
    });
    expect(first.accepted).toBe(false);

    // Second call should re-prompt.
    await p.requireTosAcceptance({
      origin: "linkedin.com",
      policyText: "...",
      bridge,
    });
    expect(calls).toBe(2);
  });
});

describe("PolicyStore.checkActivityWindow", () => {
  it("returns in_window=true inside the window and false outside (deterministic clock)", () => {
    const p = new PolicyStore();
    // Inject a fixed UTC clock + tz so the assertion is exact, not flaky.
    const inside = p.checkActivityWindow({
      start: "09:00",
      end: "17:00",
      tz: "UTC",
      now: new Date("2026-06-21T12:00:00Z"),
    });
    expect(inside.in_window).toBe(true);
    expect(inside.next_window_at).toBeTruthy();

    const outside = p.checkActivityWindow({
      start: "09:00",
      end: "17:00",
      tz: "UTC",
      now: new Date("2026-06-21T20:00:00Z"),
    });
    expect(outside.in_window).toBe(false);

    // Boundary: end is exclusive — exactly 17:00 is NOT in the window.
    const atEnd = p.checkActivityWindow({
      start: "09:00",
      end: "17:00",
      tz: "UTC",
      now: new Date("2026-06-21T17:00:00Z"),
    });
    expect(atEnd.in_window).toBe(false);
  });

  it("rejects malformed HH:MM", () => {
    const p = new PolicyStore();
    expect(() => p.checkActivityWindow({ start: "nope", end: "10:00" })).toThrow(
      /invalid HH:MM/,
    );
  });
});
