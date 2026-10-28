/** Daemon HTTP app factory — auth, CORS, MCP, control-plane routes. */

import { Hono } from "hono";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { TabId } from "@fn-browser/browser/cdp";
import { PERMISSIVE_ORIGIN_POLICY, REMOTE_ORIGIN_POLICY, type McpServer } from "@fn-browser/browser/mcp";
import type { Browsers } from "../browsers.js";
import { createMcpServer } from "../mcp-server.js";
import { createSessionsRouter } from "../routes/sessions.js";
import {
  createGlobalPolicyRouter,
  applyGlobalPolicyFromEnv,
  VALID_POLICIES,
} from "../routes/global-policy.js";
import { parseAuthTokens, parseAuthScope } from "../auth/tokens.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { AppEnv } from "../auth/capabilities.js";
import { EventBus } from "../events/bus.js";
import { AuditLog } from "../observability/audit.js";
import { ConsentRegistry } from "../consent/registry.js";
import { createConsentsRouter } from "../routes/consents.js";
import { createEventsRouter } from "../routes/events.js";
import { loadPersistedGlobalPolicy, persistGlobalPolicy } from "./state.js";
import { isLoopbackBind } from "./bind.js";
import { resolveExtensionId } from "../extension.js";
import { HOST_VERSION } from "../version.js";

export interface DaemonAppDeps {
  browsers: Browsers;
  /** Bind address; a non-loopback bind requires bearer auth. */
  bind?: string;
  /** Idle-session reaper interval (ms); off by default (tests). */
  reapIntervalMs?: number;
}

export interface DaemonApp {
  app: Hono<AppEnv>;
  mcpServer: McpServer;
  bus: EventBus;
  consent: ConsentRegistry;
  /** Stop the idle reaper (if one was started via `reapIntervalMs`). */
  stopReaper(): void;
}

/** CORS for the side panel only — reflect Origin only for the pinned extension. */
function makeCorsForSidePanel(extensionId: string | undefined) {
  const pinnedOrigin = extensionId ? `chrome-extension://${extensionId}` : null;
  const isAllowedOrigin = (origin: string | undefined): origin is string => {
    if (typeof origin !== "string") return false;
    return pinnedOrigin ? origin === pinnedOrigin : origin.startsWith("chrome-extension://");
  };

  return async function corsForSidePanel(c: Context, next: Next): Promise<Response | undefined> {
    const origin = c.req.header("Origin");
    const allowed = isAllowedOrigin(origin) ? origin : null;
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: allowed
          ? {
              "Access-Control-Allow-Origin": allowed,
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, X-Session-Id, X-Run-Id, Authorization",
              "Access-Control-Max-Age": "600",
              Vary: "Origin",
            }
          : { Vary: "Origin" },
      });
    }
    await next();
    if (allowed) {
      c.res.headers.set("Access-Control-Allow-Origin", allowed);
    }
    c.res.headers.set("Vary", "Origin");
  };
}

/** CSRF guard: JSON Content-Type + reject cross-site Origin on mutating requests. */
function csrfGuard(extensionId: string | undefined): MiddlewareHandler<AppEnv> {
  const pinnedOrigin = extensionId ? `chrome-extension://${extensionId}` : null;
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    // Exact MIME essence — substring match would accept CORS-safelisted simple types.
    const essence = (c.req.header("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (essence !== "application/json") {
      return c.json({ error: "Content-Type: application/json required" }, 415);
    }
    const origin = c.req.header("Origin");
    if (origin) {
      const allowed = pinnedOrigin ? origin === pinnedOrigin : origin.startsWith("chrome-extension://");
      if (!allowed) {
        return c.json({ error: "forbidden cross-origin request" }, 403);
      }
    }
    return next();
  };
}

export function createDaemonApp(deps: DaemonAppDeps): DaemonApp {
  const { browsers } = deps;
  const bind = deps.bind ?? "127.0.0.1";
  const loopback = isLoopbackBind(bind);

  // --- Auth posture ---
  const principals = parseAuthTokens(process.env.FN_BROWSER_AUTH_TOKENS);
  const authScope = parseAuthScope(process.env.FN_BROWSER_AUTH_SCOPE);
  const httpAuthConfigured = principals.size > 0;

  if (authScope === "mcp" && principals.size === 0) {
    // Fail loud — empty tokens must not silently grant local-admin MCP access.
    throw new Error(
      "FN_BROWSER_AUTH_SCOPE=mcp requires at least one bearer principal in FN_BROWSER_AUTH_TOKENS.",
    );
  }

  if (authScope === "mcp" && !loopback) {
    // scope=mcp leaves panel routes unauthenticated — network bind would expose them.
    throw new Error(
      `FN_BROWSER_AUTH_SCOPE=mcp requires a loopback bind (panel routes stay unauthenticated); refusing with bind="${bind}".`,
    );
  }
  if (!loopback && !httpAuthConfigured) {
    throw new Error(
      `fn-browserd bound to non-loopback ${bind} without HTTP auth — set FN_BROWSER_AUTH_TOKENS.`,
    );
  }
  if (principals.size > 0) {
    console.error(
      `[fn-browser-host] bearer auth enabled (${principals.size} principal${principals.size === 1 ? "" : "s"}, scope: ${authScope === "mcp" ? "/mcp/* only" : "all routes"})`,
    );
  }

  // SSRF egress: REMOTE when network-exposed; permissive for pure loopback local dev.
  const networkExposed = !loopback || (httpAuthConfigured && authScope === "all");
  const originPolicy =
    process.env.FN_BROWSER_ORIGIN_POLICY === "remote"
      ? REMOTE_ORIGIN_POLICY
      : process.env.FN_BROWSER_ORIGIN_POLICY === "permissive"
        ? PERMISSIVE_ORIGIN_POLICY
        : networkExposed
          ? REMOTE_ORIGIN_POLICY
          : PERMISSIVE_ORIGIN_POLICY;

  const bus = new EventBus();
  const audit = new AuditLog();
  const consent = new ConsentRegistry(bus, audit);

  const { app: mcpApp, server: mcpServer } = createMcpServer({
    browsers,
    consent,
    originPolicy,
  });

  // Global policy: env > persisted > none; env-pinned locks runtime writes.
  const policyOutcome = applyGlobalPolicyFromEnv(mcpServer);
  const policyEnvLocked = policyOutcome !== null && "applied" in policyOutcome;
  if (policyOutcome && "applied" in policyOutcome) {
    console.error(
      `[fn-browser-host] global HITL policy "${policyOutcome.applied}" set from FN_BROWSER_GLOBAL_POLICY`,
    );
  } else {
    if (policyOutcome && "ignored" in policyOutcome) {
      console.error(
        `[fn-browser-host] ignoring invalid FN_BROWSER_GLOBAL_POLICY="${policyOutcome.ignored}" (expected ${[...VALID_POLICIES].join(", ")})`,
      );
    }
    const persisted = loadPersistedGlobalPolicy();
    if (persisted) {
      mcpServer.policy.setGlobalPolicy(persisted);
      console.error(`[fn-browser-host] restored global HITL policy "${persisted}" from saved state`);
    }
  }

  // Keep session registry in sync with manual Chrome tab/group changes.
  browsers.onEvent((event) => {
    if (event.topic === "tab_group_changed") {
      const p = event.payload as { tabId: number; groupId: number };
      mcpServer.sessions.reconcileTabGroupChange(p.tabId as unknown as TabId, p.groupId);
    } else if (event.topic === "tab_removed") {
      const p = event.payload as { tabId: number };
      mcpServer.sessions.detachTab(p.tabId as unknown as TabId);
    }
  });

  let reaper: ReturnType<typeof setInterval> | undefined;
  if (deps.reapIntervalMs && deps.reapIntervalMs > 0) {
    reaper = setInterval(() => {
      mcpServer.sessions.pruneIdle();
    }, deps.reapIntervalMs);
    reaper.unref?.();
  }
  const stopReaper = (): void => {
    if (reaper) clearInterval(reaper);
  };

  const app = new Hono<AppEnv>();

  // Auth first — scope=mcp uses separate middleware per path to avoid tier escalation.
  const httpAuth = createAuthMiddleware(principals);
  if (authScope === "mcp") {
    const loopbackTrust = createAuthMiddleware(new Map());
    app.use("*", (c, next) =>
      c.req.path.startsWith("/mcp/") ? httpAuth(c, next) : loopbackTrust(c, next),
    );
  } else {
    app.use("*", httpAuth);
  }

  const pinnedExtensionId = resolveExtensionId();
  app.use("*", csrfGuard(pinnedExtensionId));

  // CORS before routes (Hono registration order); pinned to the same extension id.
  const corsForSidePanel = makeCorsForSidePanel(pinnedExtensionId);
  app.use("/health", corsForSidePanel);
  app.use("/sessions", corsForSidePanel);
  app.use("/sessions/*", corsForSidePanel);
  app.use("/global-policy/*", corsForSidePanel);
  app.use("/global-policy", corsForSidePanel);
  app.use("/consents/*", corsForSidePanel);
  app.use("/consents", corsForSidePanel);
  app.use("/events", corsForSidePanel);

  app.get("/health", (c) =>
    c.json({
      ok: true,
      extension_connected: browsers.isConnected,
      browsers: browsers.list(),
      host_version: HOST_VERSION,
      active_sessions: mcpServer.sessions.list().length,
    }),
  );
  app.route("/mcp/browser", mcpApp);
  app.route("/sessions", createSessionsRouter(mcpServer));
  app.route(
    "/global-policy",
    createGlobalPolicyRouter(
      mcpServer,
      (policy, principalId, previous) => {
        persistGlobalPolicy(policy);
        void audit.append({
          kind: "global_policy_changed",
          principal: principalId,
          from: previous,
          to: policy,
        });
      },
      policyEnvLocked,
    ),
  );
  app.route("/consents", createConsentsRouter(consent));
  app.route("/events", createEventsRouter(bus));

  return { app, mcpServer, bus, consent, stopReaper };
}
