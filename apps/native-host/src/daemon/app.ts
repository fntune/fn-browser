/**
 * Daemon HTTP app factory.
 *
 * Builds the full Hono app — auth middleware, CORS, MCP endpoint, side-panel
 * routes, the consent/event/audit control plane — given a transport to the
 * extension. This is the shared seam: today the Chrome-spawned `main.ts` shim
 * builds it and owns its (EOF-bound) lifecycle; a standalone long-lived
 * `fn-browserd` will build the same app and own a persistent lifecycle. The app
 * itself is identical either way, so the network surface is verified once.
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { TabId } from "@fntune/browser/cdp";
import { PERMISSIVE_ORIGIN_POLICY, REMOTE_ORIGIN_POLICY, type McpServer } from "@fntune/browser/mcp";
import type { ExtensionBridge } from "../extension-bridge.js";
import { createMcpServer } from "../mcp-server.js";
import { createSessionsRouter } from "../routes/sessions.js";
import { createRateLimitsRouter } from "../routes/rate-limits.js";
import {
  createGlobalPolicyRouter,
  applyGlobalPolicyFromEnv,
  VALID_POLICIES,
} from "../routes/global-policy.js";
import { parseAuthTokens, parseAuthScope, parseIdentityTiers } from "../auth/tokens.js";
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
  extension: ExtensionBridge;
  /** The address the daemon binds. Used to refuse trusting the identity header
   * unless the daemon is loopback-bound (so the sidecar is its sole ingress).
   * Defaults to loopback (the Chrome-spawned shim). */
  bind?: string;
  /** When set (>0), start an idle-session reaper on this interval (ms) that
   * sweeps abandoned sessions (no successful end()) so the registry + their
   * policy state don't grow for the daemon's lifetime. Off by default so tests
   * don't leak timers; fn-browserd's long-lived main() opts in. */
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

/**
 * CORS for the Chrome side panel ONLY. The panel loads from a
 * `chrome-extension://<id>` origin and needs CORS to reach loopback. We reflect
 * the Origin only when it is the allowed extension origin — reflecting any
 * origin would let a malicious web page (or, without a pin, any other installed
 * extension) CORS-call these privileged local-admin routes (set policy, resolve
 * consents, read operator events) in default no-token mode. Other origins get
 * no ACAO, so the browser blocks them.
 *
 * When `FN_BROWSER_EXTENSION_ID` is set, the origin is pinned to that exact
 * extension (matching the WS pin); otherwise any `chrome-extension://` origin is
 * accepted (dev default — still blocks web pages).
 */
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

/**
 * CSRF guard for state-changing requests. CORS only blocks *reading* a response
 * and preflighted requests — a malicious page can still fire a "simple" POST
 * (e.g. text/plain body) to loopback, which in no-auth mode would run as local
 * admin (set policy, drive the browser). So for any non-GET request we require
 * `Content-Type: application/json` (which forces a CORS preflight for a browser,
 * blocked for non-extension origins) AND reject a cross-site browser `Origin`.
 * Native MCP clients send JSON and no Origin, so they pass.
 */
function csrfGuard(extensionId: string | undefined): MiddlewareHandler<AppEnv> {
  const pinnedOrigin = extensionId ? `chrome-extension://${extensionId}` : null;
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    // Check the exact MIME essence — a substring match would accept a
    // CORS-safelisted "simple" type like `text/plain; foo=application/json`,
    // which avoids the preflight this guard relies on.
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
  const { extension } = deps;
  const bind = deps.bind ?? "127.0.0.1";
  const loopback = isLoopbackBind(bind);

  // --- Auth posture (parsed once; malformed config throws and aborts boot) ---
  const principals = parseAuthTokens(process.env.FN_BROWSER_AUTH_TOKENS);
  const identities = parseIdentityTiers(process.env.FN_BROWSER_IDENTITY_TIERS);
  const trustIdentityHeader = process.env.FN_BROWSER_TRUST_IDENTITY_HEADER === "1";
  const authScope = parseAuthScope(process.env.FN_BROWSER_AUTH_SCOPE);
  const httpAuthConfigured = principals.size > 0 || (trustIdentityHeader && identities.size > 0);

  if (authScope === "mcp" && principals.size === 0) {
    // MCP scope is an explicit bearer-auth posture. Falling back to the
    // disabled-auth middleware here would silently grant local-admin access to
    // unauthenticated browser-control requests.
    throw new Error(
      "FN_BROWSER_AUTH_SCOPE=mcp requires at least one bearer principal in FN_BROWSER_AUTH_TOKENS.",
    );
  }

  if (authScope === "mcp" && !loopback) {
    // scope=mcp leaves the side-panel control routes on loopback trust; on a
    // network bind that would serve them unauthenticated — fail loud.
    throw new Error(
      `FN_BROWSER_AUTH_SCOPE=mcp requires a loopback bind (panel routes stay unauthenticated); refusing with bind="${bind}".`,
    );
  }
  if (authScope === "mcp" && trustIdentityHeader) {
    // The identity header implies a tailnet ingress forwarding to loopback —
    // scope=mcp would hand those remote callers the unauthenticated panel routes.
    throw new Error(
      "FN_BROWSER_AUTH_SCOPE=mcp is incompatible with FN_BROWSER_TRUST_IDENTITY_HEADER (remote ingress needs auth on every route).",
    );
  }
  if (trustIdentityHeader && !loopback) {
    // A non-loopback daemon trusting the identity header lets a direct client
    // spoof it — fail loud rather than run an auth bypass.
    throw new Error(
      `FN_BROWSER_TRUST_IDENTITY_HEADER requires a loopback bind (the tsnet sidecar must be the sole ingress); refusing with bind="${bind}".`,
    );
  }
  if (!loopback && !httpAuthConfigured) {
    // A non-loopback bind would otherwise serve the HTTP surface as local admin.
    throw new Error(
      `fn-browserd bound to non-loopback ${bind} without HTTP auth — set FN_BROWSER_AUTH_TOKENS or FN_BROWSER_IDENTITY_TIERS (+FN_BROWSER_TRUST_IDENTITY_HEADER=1).`,
    );
  }
  if (principals.size > 0) {
    console.error(
      `[fn-browser-host] bearer auth enabled (${principals.size} principal${principals.size === 1 ? "" : "s"}, scope: ${authScope === "mcp" ? "/mcp/* only" : "all routes"})`,
    );
  }
  if (trustIdentityHeader && identities.size > 0) {
    console.error(
      `[fn-browser-host] trusting upstream identity header for ${identities.size} tailnet login(s)`,
    );
  }

  // SSRF egress policy: default REMOTE (block loopback/private/link-local/
  // metadata) whenever the daemon is network-exposed or authenticated;
  // permissive only for a purely-local loopback daemon. FN_BROWSER_ORIGIN_POLICY
  // overrides explicitly either way. MCP-scoped tokens are a local-process
  // defense, not a network posture — they must not flip a purely-local daemon
  // to REMOTE (which would block automating localhost dev apps).
  const networkExposed = !loopback || (httpAuthConfigured && authScope === "all");
  const originPolicy =
    process.env.FN_BROWSER_ORIGIN_POLICY === "remote"
      ? REMOTE_ORIGIN_POLICY
      : process.env.FN_BROWSER_ORIGIN_POLICY === "permissive"
        ? PERMISSIVE_ORIGIN_POLICY
        : networkExposed
          ? REMOTE_ORIGIN_POLICY
          : PERMISSIVE_ORIGIN_POLICY;

  // Async control plane: the daemon owns the consent queue + audit trail and
  // publishes operator events. Consent is resolvable by the local side panel
  // (extension forward) or a remote operator (POST /consents/:id/resolve).
  const bus = new EventBus();
  const audit = new AuditLog();
  const consent = new ConsentRegistry(bus, audit);

  const { app: mcpApp, server: mcpServer } = createMcpServer({
    bridge: extension,
    consent,
    originPolicy,
  });

  // Global HITL policy precedence: env (re-applied each boot) > persisted state
  // (a prior panel/HTTP change) > none. Unattended QA can set it without a human
  // at the side panel; destructive ops still prompt — the invariant holds.
  const policyOutcome = applyGlobalPolicyFromEnv(mcpServer);
  // When the policy is env-pinned, lock runtime writes so a side-panel mount
  // can't overwrite it with its cached value.
  const policyEnvLocked = policyOutcome !== null && "applied" in policyOutcome;
  if (policyOutcome && "applied" in policyOutcome) {
    console.error(
      `[fn-browser-host] global HITL policy "${policyOutcome.applied}" set from FN_BROWSER_GLOBAL_POLICY`,
    );
  } else {
    // No valid env policy (unset OR misspelled) → fall back to persisted state per
    // the env > persisted > none precedence. An invalid env value must not leave
    // the host with no policy (which would start prompting/hanging unattended).
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

  // Relay extension-emitted tab/group changes into the session registry so
  // ownership stays in sync when the user manually reassigns tabs in Chrome UI.
  extension.onEvent((event) => {
    if (event.topic === "tab_group_changed") {
      const p = event.payload as { tabId: number; groupId: number };
      mcpServer.sessions.reconcileTabGroupChange(p.tabId as unknown as TabId, p.groupId);
    } else if (event.topic === "tab_removed") {
      const p = event.payload as { tabId: number };
      mcpServer.sessions.detachTab(p.tabId as unknown as TabId);
    }
  });

  // A session's policy state (rate counters, ToS acceptances) must die with the
  // session — wired so both end() and the idle reaper clear it.
  mcpServer.sessions.onSessionRemoved = (id) => mcpServer.policy.clearSession(id);

  // Idle reaper (opt-in via reapIntervalMs): sweep sessions abandoned without a
  // successful end() so the registry + their policy state don't grow for the
  // daemon's lifetime. unref() so it never keeps the process alive on its own.
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

  // Auth first: attaches a Principal to every request (local admin when no auth
  // is configured on a loopback bind; bearer/identity otherwise). The posture
  // was parsed and validated above. Under scope=mcp only `/mcp/*` requires the
  // bearer token; every other route runs the disabled-auth middleware (local
  // admin principal) so the token-less side panel keeps working. The two
  // middlewares are mutually exclusive per request — routing the /mcp/* branch
  // through the disabled middleware too would overwrite an authenticated
  // principal with local admin (a tier escalation).
  const httpAuth = createAuthMiddleware(principals, { trustIdentityHeader, identities });
  if (authScope === "mcp") {
    const loopbackTrust = createAuthMiddleware(new Map());
    app.use("*", (c, next) =>
      c.req.path.startsWith("/mcp/") ? httpAuth(c, next) : loopbackTrust(c, next),
    );
  } else {
    app.use("*", httpAuth);
  }

  // CSRF guard for state-changing requests (CORS is not CSRF protection): blocks
  // a malicious web page from firing a simple cross-origin POST to loopback that
  // would run as local admin in no-auth mode. Pinned to the fn-browser extension
  // id (default or env override), so another installed extension can't POST here.
  const pinnedExtensionId = resolveExtensionId();
  app.use("*", csrfGuard(pinnedExtensionId));

  // CORS middleware must register BEFORE the routes it protects (Hono walks
  // registrations in order). Pinned to the same extension id so only the real
  // side panel — not any installed extension — can CORS-call these local-admin
  // routes.
  const corsForSidePanel = makeCorsForSidePanel(pinnedExtensionId);
  app.use("/health", corsForSidePanel);
  app.use("/sessions", corsForSidePanel);
  app.use("/sessions/*", corsForSidePanel);
  app.use("/rate-limits", corsForSidePanel);
  app.use("/rate-limits/*", corsForSidePanel);
  app.use("/global-policy/*", corsForSidePanel);
  app.use("/global-policy", corsForSidePanel);
  app.use("/consents/*", corsForSidePanel);
  app.use("/consents", corsForSidePanel);
  app.use("/events", corsForSidePanel);

  app.get("/health", (c) =>
    c.json({
      ok: true,
      extension_connected: extension.isConnected,
      extension_version: extension.peerVersion,
      host_version: HOST_VERSION,
      active_sessions: mcpServer.sessions.list().length,
    }),
  );
  app.route("/mcp/browser", mcpApp);
  app.route("/sessions", createSessionsRouter(mcpServer));
  app.route("/rate-limits", createRateLimitsRouter(mcpServer));
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
