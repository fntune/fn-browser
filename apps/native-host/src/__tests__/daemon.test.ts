import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import { createDaemonApp } from "../daemon/app.js";
import { persistGlobalPolicy } from "../daemon/state.js";
import { DEFAULT_EXTENSION_ID } from "../extension.js";
import { ExtensionBridge } from "../extension-bridge.js";
import { NativeMessagingBridge } from "../native-messaging.js";
import { browsersOf } from "./fixtures.js";

function stubBridge(): ExtensionBridge {
  const bridge = new ExtensionBridge(new NativeMessagingBridge(new PassThrough(), new PassThrough()));
  Object.defineProperty(bridge, "isConnected", { get: () => true });
  Object.assign(bridge, { async sendCommand() { return { ok: true, result: null }; } });
  return bridge;
}

function restoreEnv(prev: string | undefined, key: string): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe("createDaemonApp", () => {
  it("subscribes to the browser registry, not to each bridge", () => {
    const extension = stubBridge();
    createDaemonApp({ browsers: browsersOf(extension) });
    // The bridge's only handler is the registry's forwarder; the tab-reconcile
    // handler hangs off the registry, so reconnects never stack handlers.
    expect(extension.eventHandlerCount).toBe(1);
  });

  it("reaps idle sessions on the configured interval; stopReaper halts it", () => {
    vi.useFakeTimers();
    try {
      const { mcpServer, stopReaper } = createDaemonApp({
        browsers: browsersOf(stubBridge()),
        reapIntervalMs: 1000,
      });
      const s = mcpServer.sessions.start({ name: "idle" });
      // Advance past the daemon's default 2h idle window; reaper intervals fire.
      vi.advanceTimersByTime(121 * 60 * 1000);
      expect(mcpServer.sessions.get(s.id)).toBeUndefined(); // reaped
      stopReaper();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no reaper when reapIntervalMs is unset (no leaked timer)", () => {
    const { stopReaper } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
    expect(() => stopReaper()).not.toThrow();
  });

  it("wires health, MCP, and the consent control plane onto one app", async () => {
    const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });

    const health = (await (await app.request("/health")).json()) as {
      ok: boolean;
      extension_connected: boolean;
    };
    expect(health).toMatchObject({ ok: true, extension_connected: true });

    const mcp = await app.request("/mcp/browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_sessions", arguments: {} },
      }),
    });
    const body = (await mcp.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({ sessions: [] });

    const consents = (await (await app.request("/consents")).json()) as { consents: unknown[] };
    expect(consents.consents).toEqual([]);
  });

  it("blocks CSRF: non-JSON POST and cross-origin POST on state-changing routes", async () => {
    const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
    // A "simple" cross-origin POST (text/plain) is the CSRF vector → 415.
    const simple = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: '{"policy":"act"}',
    });
    expect(simple.status).toBe(415);
    // Safelisted-type bypass attempt (substring contains application/json) → 415.
    const sneaky = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "text/plain; foo=application/json" },
      body: '{"policy":"act"}',
    });
    expect(sneaky.status).toBe(415);
    // charset suffix on a real json type is still accepted (essence match).
    const charset = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: '{"policy":"act"}',
    });
    expect(charset.status).toBe(200);
    // A JSON POST carrying a malicious web Origin → 403.
    const crossOrigin = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: '{"policy":"act"}',
    });
    expect(crossOrigin.status).toBe(403);
    // A JSON POST with no Origin (native MCP client) passes CSRF and runs.
    const native = await app.request("/global-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"policy":"act"}',
    });
    expect(native.status).toBe(200);
  });

  it("reflects CORS only for the PINNED extension origin (default id), not web or other extensions", async () => {
    const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
    const pinned = `chrome-extension://${DEFAULT_EXTENSION_ID}`;
    const evil = await app.request("/global-policy", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // A DIFFERENT installed extension is NOT trusted by default.
    const other = await app.request("/global-policy", {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://someotherextensionidaaaaaaaaaaaa" },
    });
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // The real fn-browser extension (default pinned id) IS reflected.
    const panel = await app.request("/global-policy", {
      method: "OPTIONS",
      headers: { Origin: pinned },
    });
    expect(panel.headers.get("Access-Control-Allow-Origin")).toBe(pinned);

    // Exact /sessions and /consents roots must also be CORS-covered.
    for (const path of ["/sessions", "/consents"]) {
      const pre = await app.request(path, { method: "OPTIONS", headers: { Origin: pinned } });
      expect(pre.headers.get("Access-Control-Allow-Origin"), path).toBe(pinned);
    }
  });

  it("pins side-panel CORS to FN_BROWSER_EXTENSION_ID when set", async () => {
    const prev = process.env.FN_BROWSER_EXTENSION_ID;
    process.env.FN_BROWSER_EXTENSION_ID = "goodext";
    try {
      const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
      const good = await app.request("/consents", {
        method: "OPTIONS",
        headers: { Origin: "chrome-extension://goodext" },
      });
      expect(good.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://goodext");
      const other = await app.request("/consents", {
        method: "OPTIONS",
        headers: { Origin: "chrome-extension://otherext" },
      });
      expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    } finally {
      restoreEnv(prev, "FN_BROWSER_EXTENSION_ID");
    }
  });

  it("falls back to persisted policy when FN_BROWSER_GLOBAL_POLICY is invalid", async () => {
    const prev = process.env.FN_BROWSER_GLOBAL_POLICY;
    persistGlobalPolicy("act"); // a prior panel/HTTP change saved to state
    process.env.FN_BROWSER_GLOBAL_POLICY = "bogus"; // misspelled env override
    try {
      const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
      const res = await app.request("/global-policy");
      // Invalid env is ignored but must NOT wipe the policy — persisted wins.
      expect(await res.json()).toMatchObject({ policy: "act" });
    } finally {
      restoreEnv(prev, "FN_BROWSER_GLOBAL_POLICY");
      persistGlobalPolicy(null);
    }
  });

  it("refuses a non-loopback bind without HTTP auth configured", () => {
    const prev = {
      tokens: process.env.FN_BROWSER_AUTH_TOKENS,
    };
    delete process.env.FN_BROWSER_AUTH_TOKENS;
    try {
      expect(() => createDaemonApp({ browsers: browsersOf(stubBridge()), bind: "0.0.0.0" })).toThrow(
        /without HTTP auth/,
      );
      // With auth configured it's allowed.
      process.env.FN_BROWSER_AUTH_TOKENS = "ci:tok:admin";
      expect(() => createDaemonApp({ browsers: browsersOf(stubBridge()), bind: "0.0.0.0" })).not.toThrow();
    } finally {
      restoreEnv(prev.tokens, "FN_BROWSER_AUTH_TOKENS");
    }
  });

  it("defaults to remote origin policy (blocks private navigation) when authenticated", async () => {
    const prev = {
      tokens: process.env.FN_BROWSER_AUTH_TOKENS,
      op: process.env.FN_BROWSER_ORIGIN_POLICY,
    };
    process.env.FN_BROWSER_AUTH_TOKENS = "ci:tok_admin:admin";
    delete process.env.FN_BROWSER_ORIGIN_POLICY;
    try {
      const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()), bind: "127.0.0.1" });
      const res = await app.request("/mcp/browser", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer tok_admin" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "navigate", arguments: { url: "http://10.0.0.1/" } },
        }),
      });
      const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
      expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
        error: { code: "navigation_blocked" },
      });
    } finally {
      restoreEnv(prev.tokens, "FN_BROWSER_AUTH_TOKENS");
      restoreEnv(prev.op, "FN_BROWSER_ORIGIN_POLICY");
    }
  });
});
