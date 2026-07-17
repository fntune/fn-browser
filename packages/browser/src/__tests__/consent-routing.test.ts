import { describe, expect, it } from "vitest";

import {
  createBrowserMcpServer,
  PolicyStore,
  SessionRegistry,
  type TransportBridge,
  type ToolResult,
} from "../mcp/index.js";
import type { SessionId } from "../cdp/types.js";

interface BridgeScript {
  consentChoice: "allow" | "deny";
  onCdp?: (method: string, params: Record<string, unknown>) => void;
}

function scriptedBridge(script: BridgeScript): TransportBridge {
  let cdpCalls = 0;
  const bridge: TransportBridge & { cdpCalls: () => number } = {
    isConnected: true,
    cdpCalls: () => cdpCalls,
    async sendToExtension(method, params): Promise<ToolResult> {
      if (method === "__internal_request_consent") {
        return { ok: true, result: { choice: script.consentChoice } };
      }
      cdpCalls++;
      script.onCdp?.(method, params);
      return { ok: true, result: { ok: true } };
    },
  };
  return bridge;
}

describe("destructive consent routing", () => {
  it("gates click(destructive=true) through requireConsent; denial blocks CDP", async () => {
    const bridge = scriptedBridge({ consentChoice: "deny" }) as TransportBridge & {
      cdpCalls: () => number;
    };
    const server = createBrowserMcpServer({
      bridge,
      sessionRegistry: new SessionRegistry(),
      policyStore: new PolicyStore(),
    });

    const r = await server.callTool("click", { tabId: 1, selector: "button", destructive: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("consent_denied");

    expect(bridge.cdpCalls()).toBe(0);
  });

  it("allows click(destructive=true) through when consent is allow", async () => {
    const bridge = scriptedBridge({ consentChoice: "allow" }) as TransportBridge & {
      cdpCalls: () => number;
    };
    const server = createBrowserMcpServer({
      bridge,
      sessionRegistry: new SessionRegistry(),
      policyStore: new PolicyStore(),
    });

    const r = await server.callTool("click", { tabId: 1, selector: "button", destructive: true });
    expect(r.ok).toBe(true);
    expect(bridge.cdpCalls()).toBe(1);
  });

  it("does not gate non-destructive click", async () => {
    const bridge = scriptedBridge({ consentChoice: "deny" }) as TransportBridge & {
      cdpCalls: () => number;
    };
    const server = createBrowserMcpServer({
      bridge,
      sessionRegistry: new SessionRegistry(),
      policyStore: new PolicyStore(),
    });

    const r = await server.callTool("click", { tabId: 1, selector: "button" });
    expect(r.ok).toBe(true);
    expect(bridge.cdpCalls()).toBe(1);
  });

  it("destructive click still prompts in 'act' mode (invariant per plan §HITL)", async () => {
    // Deny — if the invariant holds, the deny short-circuits and no CDP call fires.
    const bridge = scriptedBridge({ consentChoice: "deny" }) as TransportBridge & {
      cdpCalls: () => number;
    };
    const registry = new SessionRegistry();
    const server = createBrowserMcpServer({
      bridge,
      sessionRegistry: registry,
    });

    const startRes = await server.callTool("start", { name: "s" });
    if (!startRes.ok) throw new Error("start failed");
    const sessionId = (startRes.result as { sessionId: SessionId }).sessionId;
    registry.setPolicy(sessionId, "act");
    registry.attachTab(sessionId, 42 as unknown as import("../cdp/types.js").TabId);

    const r = await server.callTool(
      "click",
      { tabId: 42, selector: "button", destructive: true },
      { sessionId },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("consent_denied");
    expect(bridge.cdpCalls()).toBe(0);
  });

  it("'act' mode auto-allows explicit non-destructive require_consent calls", async () => {
    // Deny would only fire if bridge were consulted; policy short-circuit must prevent it.
    let bridgeCalled = false;
    const registry = new SessionRegistry();
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method): Promise<ToolResult> {
        if (method === "__internal_request_consent") {
          bridgeCalled = true;
          return { ok: true, result: { choice: "deny" } };
        }
        return { ok: true, result: { ok: true } };
      },
    };
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });

    const startRes = await server.callTool("start", { name: "s" });
    if (!startRes.ok) throw new Error("start failed");
    const sessionId = (startRes.result as { sessionId: SessionId }).sessionId;
    registry.setPolicy(sessionId, "act");

    const r = await server.callTool(
      "require_consent",
      { title: "heads up", body: "fyi", destructive: false },
      { sessionId },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { choice: string }).choice).toBe("allow");
    expect(bridgeCalled).toBe(false);
  });

  it("'ask' mode prompts even for non-destructive require_consent", async () => {
    let bridgeCalled = false;
    const registry = new SessionRegistry();
    const bridge: TransportBridge = {
      isConnected: true,
      async sendToExtension(method): Promise<ToolResult> {
        if (method === "__internal_request_consent") {
          bridgeCalled = true;
          return { ok: true, result: { choice: "allow" } };
        }
        return { ok: true, result: {} };
      },
    };
    const server = createBrowserMcpServer({ bridge, sessionRegistry: registry });

    const startRes = await server.callTool("start", { name: "s" });
    if (!startRes.ok) throw new Error("start failed");
    const sessionId = (startRes.result as { sessionId: SessionId }).sessionId;
    // policy defaults to "ask"

    const r = await server.callTool(
      "require_consent",
      { title: "heads up", body: "fyi", destructive: false },
      { sessionId },
    );
    expect(r.ok).toBe(true);
    expect(bridgeCalled).toBe(true);
  });
});
