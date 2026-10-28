import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { SessionId, TabId } from "@fntune/browser/cdp";

import { createMcpServer, REQUEST_TIMEOUT_MS, requestTimeoutMsFromEnv } from "../mcp-server.js";
import { ExtensionBridge, type CommandResult, type CommandFailure } from "../extension-bridge.js";
import { NativeMessagingBridge } from "../native-messaging.js";
import { browsersOf } from "./fixtures.js";

function makeBridge(overrides: Partial<ExtensionBridge> = {}): ExtensionBridge {
  const input = new PassThrough();
  const output = new PassThrough();
  const native = new NativeMessagingBridge(input, output);
  const bridge = new ExtensionBridge(native);
  Object.defineProperty(bridge, "isConnected", { get: () => true, configurable: true });
  Object.assign(bridge, overrides);
  return bridge;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createMcpServer (JSON-RPC HTTP)", () => {
  it("reads the request timeout budget from the environment with a 60s default", () => {
    const previous = process.env.FN_BROWSER_REQUEST_TIMEOUT_MS;
    try {
      delete process.env.FN_BROWSER_REQUEST_TIMEOUT_MS;
      expect(requestTimeoutMsFromEnv()).toBe(60_000);

      process.env.FN_BROWSER_REQUEST_TIMEOUT_MS = "1234";
      expect(requestTimeoutMsFromEnv()).toBe(1234);

      process.env.FN_BROWSER_REQUEST_TIMEOUT_MS = "0";
      expect(requestTimeoutMsFromEnv()).toBe(60_000);
    } finally {
      if (previous === undefined) {
        delete process.env.FN_BROWSER_REQUEST_TIMEOUT_MS;
      } else {
        process.env.FN_BROWSER_REQUEST_TIMEOUT_MS = previous;
      }
    }

    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("honors zero as the documented session idle-reaper disable value", () => {
    const previous = process.env.FN_BROWSER_SESSION_IDLE_MS;
    try {
      process.env.FN_BROWSER_SESSION_IDLE_MS = "0";
      const { sessions } = createMcpServer({ browsers: browsersOf(makeBridge()) });
      const session = sessions.start({ name: "long-lived" });
      (session as { lastHeartbeat: Date }).lastHeartbeat = new Date(0);

      expect(sessions.pruneIdle(new Date("2100-01-01T00:00:00.000Z"))).toEqual([]);
      expect(sessions.has(session.id)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.FN_BROWSER_SESSION_IDLE_MS;
      } else {
        process.env.FN_BROWSER_SESSION_IDLE_MS = previous;
      }
    }
  });

  it("responds to initialize with server metadata", async () => {
    const { app } = createMcpServer({ browsers: browsersOf(makeBridge()) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; capabilities: { tools: object } };
    };
    expect(body.result.serverInfo.name).toBe("fn-browser");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("tools/list returns the full catalog", async () => {
    const { app } = createMcpServer({ browsers: browsersOf(makeBridge()) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: object }> };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["upload_file", "navigate", "observe", "rate_limit_check", "start"]));
    expect(body.result.tools.every((t) => typeof t.inputSchema === "object")).toBe(true);
  });

  it("forwards tools/call upload_file to the bridge", async () => {
    const bridge = makeBridge({
      sendCommand: async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<CommandResult | CommandFailure> => {
        expect(method).toBe("upload_file");
        expect(params).toEqual({ tabId: 7, selector: "input", path: "/x/resume.pdf" });
        return { ok: true, result: { ok: true, path: "/x/resume.pdf" } };
      },
    } as unknown as Partial<ExtensionBridge>);

    const { app } = createMcpServer({ browsers: browsersOf(bridge) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "upload_file",
          arguments: { tabId: 7, selector: "input", path: "/x/resume.pdf" },
        },
      }),
    });
    const body = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({
      ok: true,
      path: "/x/resume.pdf",
    });
  });

  it("isError=true on bridge failure", async () => {
    const bridge = makeBridge({
      sendCommand: async (): Promise<CommandResult | CommandFailure> => ({
        ok: false,
        error: { code: "element_not_found", message: "no input" },
      }),
    } as unknown as Partial<ExtensionBridge>);

    const { app } = createMcpServer({ browsers: browsersOf(bridge) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "navigate", arguments: { tabId: 1, url: "about:blank" } },
      }),
    });
    const body = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({
      error: { code: "element_not_found", message: "no input" },
    });
  });

  it("rate_limit_check resolves entirely in-host without touching the bridge", async () => {
    let bridgeCalls = 0;
    const bridge = makeBridge({
      sendCommand: async (): Promise<CommandResult | CommandFailure> => {
        bridgeCalls++;
        return { ok: true, result: null };
      },
    } as unknown as Partial<ExtensionBridge>);

    const { app } = createMcpServer({ browsers: browsersOf(bridge) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "rate_limit_check",
          arguments: { tag: "x", max: 3, window: "minute" },
        },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
      allowed: true,
      remaining: 3,
    });
    expect(bridgeCalls).toBe(0);
  });

  it("accepts sessionId tool arguments when the MCP client cannot set X-Session-Id", async () => {
    // start/info/end on an un-tabbed session resolve entirely in-host; the
    // bridge is never consulted (the group is created lazily on first tab).
    const bridge = makeBridge({
      sendCommand: async (): Promise<CommandResult | CommandFailure> => ({
        ok: true,
        result: null,
      }),
    } as unknown as Partial<ExtensionBridge>);
    const { app } = createMcpServer({ browsers: browsersOf(bridge) });

    const startRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "start", arguments: { name: "smoke" } },
      }),
    });
    const startBody = (await startRes.json()) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const sessionId = (JSON.parse(startBody.result.content[0]!.text) as { sessionId: string })
      .sessionId;

    const infoRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "info", arguments: { sessionId } },
      }),
    });
    const infoBody = (await infoRes.json()) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(infoBody.result.isError).toBeUndefined();
    expect(JSON.parse(infoBody.result.content[0]!.text)).toMatchObject({ sessionId });

    const endRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "end", arguments: { sessionId } },
      }),
    });
    const endBody = (await endRes.json()) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(endBody.result.isError).toBeUndefined();
    expect(JSON.parse(endBody.result.content[0]!.text)).toMatchObject({ ok: true });
  });

  it("ghost-restores a header session id after daemon restart", async () => {
    const ghostSessionId = "ghost-restore-test" as SessionId;
    const { app, sessions } = createMcpServer({ browsers: browsersOf(makeBridge()) });
    expect(sessions.has(ghostSessionId)).toBe(false);

    const res = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Session-Id": ghostSessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "info", arguments: {} },
      }),
    });
    const body = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    const payload = JSON.parse(body.result.content[0]!.text) as {
      sessionId?: string;
      error?: { code: string };
    };

    expect(body.result.isError).toBeUndefined();
    expect(payload.error?.code).not.toBe("no_session");
    expect(payload.sessionId).toBe(ghostSessionId);
    expect(sessions.has(ghostSessionId)).toBe(true);
  });

  it("ghost-restores a session id supplied as a tool argument", async () => {
    const ghostSessionId = "ghost-argument-session" as SessionId;
    const { app, sessions } = createMcpServer({ browsers: browsersOf(makeBridge()) });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "info", arguments: { sessionId: ghostSessionId } },
      }),
    });
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };

    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
      sessionId: ghostSessionId,
    });
    expect(sessions.has(ghostSessionId)).toBe(true);
  });

  it("does not dispatch a consent-gated action after the HTTP request times out", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let consentStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      consentStarted = resolve;
    });
    let resolveConsent!: (result: CommandResult | CommandFailure) => void;
    const bridge = makeBridge({
      sendCommand: async (method: string): Promise<CommandResult | CommandFailure> => {
        calls.push(method);
        if (method === "__internal_request_consent") {
          consentStarted();
          return new Promise((resolve) => {
            resolveConsent = resolve;
          });
        }
        return { ok: true, result: { clicked: true } };
      },
    } as unknown as Partial<ExtensionBridge>);
    const { app } = createMcpServer({ browsers: browsersOf(bridge) });

    const responsePromise = app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "click",
          arguments: { tabId: 1, selector: "button", destructive: true },
        },
      }),
    });
    await started;

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const response = await responsePromise;
    expect(await response.json()).toMatchObject({
      error: { code: -32000, message: "request timed out" },
    });

    resolveConsent({ ok: true, result: { choice: "allow" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["__internal_request_consent"]);
  });

  it("does not dispatch a consent-gated action after the client disconnects", async () => {
    const calls: string[] = [];
    let consentStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      consentStarted = resolve;
    });
    let resolveConsent!: (result: CommandResult | CommandFailure) => void;
    const bridge = makeBridge({
      sendCommand: async (method: string): Promise<CommandResult | CommandFailure> => {
        calls.push(method);
        if (method === "__internal_request_consent") {
          consentStarted();
          return new Promise((resolve) => {
            resolveConsent = resolve;
          });
        }
        return { ok: true, result: { clicked: true } };
      },
    } as unknown as Partial<ExtensionBridge>);
    const { app } = createMcpServer({ browsers: browsersOf(bridge) });
    const controller = new AbortController();
    const responsePromise = app.request(
      new Request("http://localhost/", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: {
            name: "click",
            arguments: { tabId: 1, selector: "button", destructive: true },
          },
        }),
      }),
    );
    await started;

    controller.abort();
    const response = await responsePromise;
    expect(await response.json()).toMatchObject({
      error: { code: -32001, message: "request cancelled" },
    });

    resolveConsent({ ok: true, result: { choice: "allow" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["__internal_request_consent"]);
  });

  it("auto-retries an idempotent read once across a brief flap, hiding it from the caller", async () => {
    let calls = 0;
    let connected = true; // passes the extension-backed gate
    const bridge = makeBridge({
      sendCommand: async (): Promise<CommandResult | CommandFailure> => {
        calls++;
        if (calls === 1) {
          connected = false; // flap mid-command
          setTimeout(() => {
            connected = true;
          }, 80); // extension reconnects shortly
          return { ok: false, error: { code: "extension_unreachable", message: "flap" } };
        }
        return { ok: true, result: { title: "recovered" } };
      },
    } as unknown as Partial<ExtensionBridge>);
    Object.defineProperty(bridge, "isConnected", { get: () => connected });

    const { app } = createMcpServer({ browsers: browsersOf(bridge) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "read_page", arguments: { tabId: 1 } },
      }),
    });
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ title: "recovered" });
    expect(calls).toBe(2); // retried exactly once
  });

  it("re-checks tab ownership before retrying a read after reconnect", async () => {
    let calls = 0;
    let connected = true;
    let firstAttempt!: () => void;
    const attempted = new Promise<void>((resolve) => {
      firstAttempt = resolve;
    });
    const bridge = makeBridge({
      sendCommand: async (): Promise<CommandResult | CommandFailure> => {
        calls++;
        if (calls === 1) {
          connected = false;
          firstAttempt();
          return { ok: false, error: { code: "extension_unreachable", message: "flap" } };
        }
        return { ok: true, result: { title: "must-not-leak" } };
      },
    } as unknown as Partial<ExtensionBridge>);
    Object.defineProperty(bridge, "isConnected", { get: () => connected });
    const { server, sessions } = createMcpServer({ browsers: browsersOf(bridge) });
    const sessionId = "owned-session" as SessionId;
    const nextSessionId = "next-session" as SessionId;
    const tabId = 7 as TabId;
    sessions.create({ id: sessionId, ownerPrincipalId: "alice" });
    sessions.create({ id: nextSessionId, ownerPrincipalId: "bob" });
    sessions.attachTab(sessionId, tabId);

    const pending = server.callTool(
      "read_page",
      { tabId },
      { sessionId, principalId: "alice", authenticated: true },
    );
    await attempted;
    sessions.attachTab(nextSessionId, tabId);
    connected = true;

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "cross_session_tab" },
    });
    expect(calls).toBe(1);
  });

  it("re-checks session ownership before retrying a tab-group read", async () => {
    let calls = 0;
    let connected = true;
    let firstAttempt!: () => void;
    const attempted = new Promise<void>((resolve) => {
      firstAttempt = resolve;
    });
    const bridge = makeBridge({
      sendCommand: async (): Promise<CommandResult | CommandFailure> => {
        calls++;
        connected = false;
        firstAttempt();
        return { ok: false, error: { code: "extension_unreachable", message: "flap" } };
      },
    } as unknown as Partial<ExtensionBridge>);
    Object.defineProperty(bridge, "isConnected", { get: () => connected });
    const { server, sessions } = createMcpServer({ browsers: browsersOf(bridge) });
    const sessionId = "listed-session" as SessionId;
    sessions.create({ id: sessionId, ownerPrincipalId: "alice" });
    sessions.bindTabGroup(sessionId, 10, 1);

    const pending = server.callTool(
      "list_tabs",
      {},
      { sessionId, principalId: "alice", authenticated: true },
    );
    await attempted;
    await sessions.end({
      sessionId,
      bridge: {
        isConnected: true,
        async sendToExtension() {
          return { ok: true, result: null };
        },
      },
    });
    connected = true;

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "no_session" },
    });
    expect(calls).toBe(1);
  });

  it("holds then dispatches an idempotent read that starts during reconnect", async () => {
    let calls = 0;
    let connected = false;
    const bridge = makeBridge({
      sendCommand: async (): Promise<CommandResult | CommandFailure> => {
        calls++;
        return { ok: true, result: { title: "recovered" } };
      },
    } as unknown as Partial<ExtensionBridge>);
    Object.defineProperty(bridge, "isConnected", { get: () => connected });
    setTimeout(() => {
      connected = true;
    }, 80);

    const { app } = createMcpServer({ browsers: browsersOf(bridge) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "read_page", arguments: { tabId: 1 } },
      }),
    });
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ title: "recovered" });
    expect(calls).toBe(1);
  });

  it("does NOT retry a mutating op on extension_unreachable (at-most-once)", async () => {
    let calls = 0;
    const bridge = makeBridge({
      sendCommand: async (): Promise<CommandResult | CommandFailure> => {
        calls++;
        return { ok: false, error: { code: "extension_unreachable", message: "flap" } };
      },
    } as unknown as Partial<ExtensionBridge>);

    const { app } = createMcpServer({ browsers: browsersOf(bridge) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "navigate", arguments: { tabId: 1, url: "about:blank" } },
      }),
    });
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({
      error: { code: "extension_unreachable", message: "flap" },
    });
    expect(calls).toBe(1); // no retry
  });

  it("returns JSON-RPC error for unknown methods", async () => {
    const { app } = createMcpServer({ browsers: browsersOf(makeBridge()) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "does-not-exist" }),
    });
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
  });
});
