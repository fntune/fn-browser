import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { PassThrough } from "node:stream";

import { createMcpServer } from "../mcp-server.js";
import { ExtensionBridge } from "../extension-bridge.js";
import { NativeMessagingBridge } from "../native-messaging.js";
import { parseAuthTokens, parseIdentityTiers } from "../auth/tokens.js";
import {
  argScopedTierAllows,
  authorizeTool,
  TIER_CAPABILITIES,
  type AppEnv,
  type Principal,
} from "../auth/capabilities.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { browsersOf } from "./fixtures.js";

function stubBridge(): ExtensionBridge {
  const bridge = new ExtensionBridge(new NativeMessagingBridge(new PassThrough(), new PassThrough()));
  Object.defineProperty(bridge, "isConnected", { get: () => true });
  Object.assign(bridge, {
    async sendCommand() {
      return { ok: true, result: { ok: true } };
    },
  });
  return bridge;
}

async function callTool(
  app: Hono<AppEnv>,
  name: string,
  token?: string,
): Promise<{ status: number; body: { result?: unknown; error?: { code: number; message: string } } }> {
  const res = await app.request("/mcp/browser", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  return { status: res.status, body: (await res.json()) as never };
}

function appWithTokens(raw: string | undefined): Hono<AppEnv> {
  const principals = parseAuthTokens(raw);
  const { app: mcpApp } = createMcpServer({ browsers: browsersOf(stubBridge()) });
  const app = new Hono<AppEnv>();
  app.use("*", createAuthMiddleware(principals));
  app.route("/mcp/browser", mcpApp);
  return app;
}

describe("parseAuthTokens", () => {
  it("returns an empty table when unset (auth disabled)", () => {
    expect(parseAuthTokens(undefined).size).toBe(0);
    expect(parseAuthTokens("").size).toBe(0);
    expect(parseAuthTokens("   ").size).toBe(0);
  });

  it("fails loud when set but producing zero entries (auth not silently disabled)", () => {
    expect(() => parseAuthTokens(",")).toThrow(/no valid entries/);
    expect(() => parseAuthTokens(", ,")).toThrow(/no valid entries/);
  });

  it("parses name:token:tier entries into principals", () => {
    const table = parseAuthTokens("ci:tok_act:act,desk:tok_admin:admin");
    expect(table.get("tok_act")).toMatchObject({ id: "ci", tier: "act" });
    expect(table.get("tok_admin")).toMatchObject({ id: "desk", tier: "admin" });
  });

  it("throws on malformed entries, unknown tiers, and duplicate tokens", () => {
    expect(() => parseAuthTokens("bad-entry")).toThrow(/malformed/);
    expect(() => parseAuthTokens("ci:tok:wizard")).toThrow(/unknown tier/);
    expect(() => parseAuthTokens("a:dup:act,b:dup:read")).toThrow(/duplicate/);
  });

  it("allows paired tokens to share a principal (read rides alongside act)", () => {
    // Same name = same principal ON PURPOSE: a read token observes the sessions
    // an act token of the same principal creates. Both parse; only a duplicate
    // raw token is an error.
    const table = parseAuthTokens("ci:tok_act:act,ci:tok_read:read");
    expect(table.get("tok_act")).toMatchObject({ id: "ci", tier: "act" });
    expect(table.get("tok_read")).toMatchObject({ id: "ci", tier: "read" });
    expect(() => parseAuthTokens("ci:dup:act,ci:dup:read")).toThrow(/duplicate token/);
  });
});

describe("capability tiers", () => {
  const principal = (tier: "read" | "act" | "admin"): Principal => ({
    id: tier,
    tier,
    capabilities: TIER_CAPABILITIES[tier],
  });

  it("read tier can read but not act, upload, or eval", () => {
    const p = principal("read");
    expect(authorizeTool(p, "read_page").allowed).toBe(true);
    expect(authorizeTool(p, "navigate").allowed).toBe(false);
    expect(authorizeTool(p, "upload_file").allowed).toBe(false);
    expect(authorizeTool(p, "evaluate_js").allowed).toBe(false);
  });

  it("act tier can act but not upload or eval (privileged, admin-only)", () => {
    const p = principal("act");
    expect(authorizeTool(p, "navigate").allowed).toBe(true);
    expect(authorizeTool(p, "click").allowed).toBe(true);
    expect(authorizeTool(p, "run_flow").allowed).toBe(true);
    expect(authorizeTool(p, "upload_file").allowed).toBe(false);
    expect(authorizeTool(p, "evaluate_js").allowed).toBe(false);
  });

  it("admin tier holds everything including the privileged writes", () => {
    const p = principal("admin");
    expect(authorizeTool(p, "upload_file").allowed).toBe(true);
    expect(authorizeTool(p, "evaluate_js").allowed).toBe(true);
  });

  it("read tier may manage its OWN session lifecycle (start + end), not tab writes", () => {
    const p = principal("read");
    expect(authorizeTool(p, "info").allowed).toBe(true);
    expect(authorizeTool(p, "list_sessions").allowed).toBe(true);
    // start + end manage the caller's own session (ownership guard blocks
    // others); read needs both so it doesn't accumulate empty sessions.
    expect(authorizeTool(p, "start").allowed).toBe(true);
    expect(authorizeTool(p, "end").allowed).toBe(true);
    // But read still can't create/adopt tabs.
    expect(authorizeTool(p, "create_tab").allowed).toBe(false);
    expect(authorizeTool(p, "adopt_tab").allowed).toBe(false);
  });

  it("keeps rate-limit mutations out of the read tier", () => {
    // rate_limit_check/consume mutate shared quota state — read must not reach them.
    expect(authorizeTool(principal("read"), "rate_limit_check").allowed).toBe(false);
    expect(authorizeTool(principal("read"), "rate_limit_consume").allowed).toBe(false);
    expect(authorizeTool(principal("act"), "rate_limit_consume").allowed).toBe(true);
  });

  it("keeps prompt-producing tools out of the read tier but allows pure reads", () => {
    // require_consent spams prompts; require_tos_acceptance mutates the ToS set.
    expect(authorizeTool(principal("read"), "require_consent").allowed).toBe(false);
    expect(authorizeTool(principal("read"), "require_tos_acceptance").allowed).toBe(false);
    expect(authorizeTool(principal("act"), "require_consent").allowed).toBe(true);
    // check_activity_window is a pure computation — still allowed for read.
    expect(authorizeTool(principal("read"), "check_activity_window").allowed).toBe(true);
  });

  it("denies unknown tools (fail closed)", () => {
    expect(authorizeTool(principal("admin"), "not_a_tool").allowed).toBe(false);
  });

  it("arg-scoped: read tier may end (leave) its session but not close tabs", () => {
    // end with on_tabs:"close" is a destructive browser-state change — act+.
    expect(argScopedTierAllows("end", { on_tabs: "close" }, "read")).toBe(false);
    expect(argScopedTierAllows("end", { on_tabs: "close" }, "act")).toBe(true);
    expect(argScopedTierAllows("end", { on_tabs: "close" }, "admin")).toBe(true);
    // Dissolving the group (default/leave) is fine for read.
    expect(argScopedTierAllows("end", { on_tabs: "leave" }, "read")).toBe(true);
    expect(argScopedTierAllows("end", {}, "read")).toBe(true);
  });

  it("arg-scoped: list_tabs scope:'all' is admin-only, session scope is any-tier", () => {
    // scope:"all" enumerates cross-session tabs — admin only.
    expect(argScopedTierAllows("list_tabs", { scope: "all" }, "read")).toBe(false);
    expect(argScopedTierAllows("list_tabs", { scope: "all" }, "act")).toBe(false);
    expect(argScopedTierAllows("list_tabs", { scope: "all" }, "admin")).toBe(true);
    // session-scoped (or unset) is fine for any tier.
    expect(argScopedTierAllows("list_tabs", { scope: "session" }, "read")).toBe(true);
    expect(argScopedTierAllows("list_tabs", {}, "read")).toBe(true);
    // unrelated tools are unaffected.
    expect(argScopedTierAllows("navigate", { scope: "all" }, "read")).toBe(true);
  });
});

describe("auth middleware over the MCP surface", () => {
  it("disabled (no tokens) runs as local admin — eval allowed", async () => {
    const app = appWithTokens(undefined);
    const { status, body } = await callTool(app, "evaluate_js");
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  it("enabled: 401 without a token", async () => {
    const app = appWithTokens("ci:tok_act:act");
    const res = await app.request("/mcp/browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_page", arguments: {} } }),
    });
    expect(res.status).toBe(401);
  });

  it("enabled: act token may navigate but is forbidden evaluate_js", async () => {
    const app = appWithTokens("ci:tok_act:act");
    const nav = await callTool(app, "navigate", "tok_act");
    expect(nav.body.error).toBeUndefined();

    const evil = await callTool(app, "evaluate_js", "tok_act");
    expect(evil.body.error?.code).toBe(-32003);
    expect(evil.body.error?.message).toMatch(/js\.evaluate/);
  });

  it("enabled: admin token may evaluate_js", async () => {
    const app = appWithTokens("desk:tok_admin:admin");
    const evil = await callTool(app, "evaluate_js", "tok_admin");
    expect(evil.body.error).toBeUndefined();
  });

  it("restricts list_tabs scope:all to admin", async () => {
    const app = appWithTokens("ci:tok_read:read,boss:tok_admin:admin");
    const listAll = async (token: string) => {
      const res = await app.request("/mcp/browser", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_tabs", arguments: { scope: "all" } },
        }),
      });
      return (await res.json()) as { error?: { code: number } };
    };
    expect((await listAll("tok_read")).error?.code).toBe(-32003); // read denied
    expect((await listAll("tok_admin")).error?.code).not.toBe(-32003); // admin passes the gate
  });
});

describe("trusted tailnet identity header", () => {
  function appWithIdentity(tiers: string): Hono<AppEnv> {
    const { app: mcpApp } = createMcpServer({ browsers: browsersOf(stubBridge()) });
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      createAuthMiddleware(new Map(), {
        trustIdentityHeader: true,
        identities: parseIdentityTiers(tiers),
      }),
    );
    app.route("/mcp/browser", mcpApp);
    return app;
  }

  async function call(app: Hono<AppEnv>, name: string, login?: string) {
    const res = await app.request("/mcp/browser", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(login ? { "Tailscale-User-Login": login } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    });
    return { status: res.status, body: (await res.json()) as { error?: { code: number } } };
  }

  it("parses login:tier (splitting on the last colon)", () => {
    const table = parseIdentityTiers("alice@example.com:admin,bob@corp.io:read");
    expect(table.get("alice@example.com")).toMatchObject({ id: "alice@example.com", tier: "admin" });
    expect(table.get("bob@corp.io")).toMatchObject({ tier: "read" });
    expect(() => parseIdentityTiers("alice@example.com:wizard")).toThrow(/unknown tier/);
  });

  it("rejects duplicate logins (incl. case variants) so entry order can't decide tier", () => {
    expect(() => parseIdentityTiers("alice@example.com:read,alice@example.com:admin")).toThrow(
      /duplicate login/,
    );
    expect(() => parseIdentityTiers("Alice@Example.com:read,alice@example.com:admin")).toThrow(
      /duplicate login/,
    );
  });

  it("maps a verified login header to its tier", async () => {
    const app = appWithIdentity("alice@example.com:admin,bob@corp.io:read");
    expect((await call(app, "evaluate_js", "alice@example.com")).body.error).toBeUndefined();
    // bob is read-only — evaluate_js forbidden
    expect((await call(app, "evaluate_js", "bob@corp.io")).body.error?.code).toBe(-32003);
  });

  it("401s an unknown or absent login", async () => {
    const app = appWithIdentity("alice@example.com:admin");
    expect((await call(app, "read_page", "mallory@evil.com")).status).toBe(401);
    expect((await call(app, "read_page")).status).toBe(401);
  });
});
