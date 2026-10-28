import { describe, expect, it } from "vitest";

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
  // Destructive always prompts; non-destructive auto-allows under act/follow_plan.
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
