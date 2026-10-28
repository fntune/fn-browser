/** HTTP MCP endpoint; X-Session-Id header wins, tool arg is fallback. */

import { Hono } from "hono";
import {
  createBrowserMcpServer,
  PERMISSIVE_ORIGIN_POLICY,
  PolicyStore,
  REMOTE_ORIGIN_POLICY,
  SessionRegistry,
  type OriginPolicy,
  type TransportBridge,
  type TransportRequestOptions,
  type ToolResult,
  type McpServer,
  isReplaySafeTool,
} from "@fn-browser/browser/mcp";
import type { SessionId, TabId } from "@fn-browser/browser/cdp";
import { createHostToolPlugins } from "./plugins.js";
import type { Browsers } from "./browsers.js";
import { RunLog, summarize } from "./observability/run-log.js";
import { saveScreenshot } from "./observability/screenshot-store.js";
import { HOST_VERSION } from "./version.js";
import { CommandScheduler, type SchedulerConfig } from "./scheduler.js";
import {
  argScopedTierAllows,
  authorizeTool,
  type AppEnv,
  type Principal,
} from "./auth/capabilities.js";
import { LOCAL_PRINCIPAL } from "./auth/middleware.js";
import type { ConsentSink, ConsentRequestParams } from "./consent/registry.js";
import { createSessionIdentity } from "./session-identity.js";

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpServerDeps {
  browsers: Browsers;
  /** When set, consent routes through the daemon registry; else extension-only. */
  consent?: ConsentSink;
  /** SSRF egress policy; defaults from FN_BROWSER_ORIGIN_POLICY when absent. */
  originPolicy?: OriginPolicy;
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Tab mutators — dropped at dispatch if the session began closing while queued. */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "fill_form",
  "upload_file",
  "evaluate_js",
  "adopt_tab",
]);

/** Max wait before the single idempotent read-retry gives up. */
const RECONNECT_WAIT_MS = 3_000;
const RECONNECT_POLL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export function requestTimeoutMsFromEnv(): number {
  return positiveIntEnv("FN_BROWSER_REQUEST_TIMEOUT_MS") ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

export const REQUEST_TIMEOUT_MS = requestTimeoutMsFromEnv();

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createMcpServer(deps: McpServerDeps): {
  app: Hono<AppEnv>;
  server: McpServer;
  sessions: SessionRegistry;
  policy: PolicyStore;
} {
  const scheduler = new CommandScheduler(schedulerConfigFromEnv());
  const sessionIdentity = createSessionIdentity(process.env.FN_BROWSER_SESSION_SIGNING_KEY);
  // Own registry so dispatch can re-check session.closing and run the idle reaper.
  const sessions = new SessionRegistry(
    undefined,
    undefined,
    sessionIdleMsFromEnv(),
    sessionIdentity.createSessionId,
  );
  const policy = new PolicyStore(sessions);

  /** Wait for `browser` (or any browser when undefined) to (re)connect. */
  const waitForBrowser = async (
    browser: string | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const ready = (): boolean =>
      browser === undefined ? deps.browsers.isConnected : deps.browsers.get(browser) !== undefined;
    const deadline = performance.now() + RECONNECT_WAIT_MS;
    while (!ready() && !signal?.aborted && performance.now() < deadline) {
      await delay(RECONNECT_POLL_MS);
    }
    return ready() && !signal?.aborted;
  };

  const sendTo = async (
    browser: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolResult> => {
    const bridge = deps.browsers.get(browser);
    if (!bridge) return browserUnreachable(browser);
    return bridge.sendCommand(method, params, timeoutMs !== undefined ? { timeoutMs } : undefined);
  };

  const forwardRaw = async (
    browser: string,
    method: string,
    params: Record<string, unknown>,
    options?: TransportRequestOptions,
    validateRetry?: () => ToolResult | undefined,
  ): Promise<ToolResult> => {
    if (options?.signal?.aborted) return requestCancelledResult();
    const res = await sendTo(browser, method, params, options?.timeoutMs);
    if (res.ok) return res;
    // Idempotent reads: one reconnect wait + retry; mutators never retry (at-most-once).
    if (res.error.code === "extension_unreachable" && isReplaySafeTool(method)) {
      if (await waitForBrowser(browser, options?.signal)) {
        if (options?.signal?.aborted) return requestCancelledResult();
        const invalid = validateRetry?.();
        if (invalid) return invalid;
        return sendTo(browser, method, params, options?.timeoutMs);
      }
    }
    return res;
  };

  /** The connected browser holding `tabId`; probes each one when several are connected. */
  const locateTab = async (tabId: number): Promise<string | undefined> => {
    const ids = deps.browsers.ids();
    if (ids.length <= 1) return ids[0];
    const holds = await Promise.all(
      ids.map(async (id) => {
        const res = await sendTo(id, "list_tabs", {});
        return res.ok && Array.isArray(res.result) && res.result.some((tab) => isRecord(tab) && tab.id === tabId);
      }),
    );
    return ids[holds.indexOf(true)];
  };

  /** Browser for one command: the session's, else the tab's, else the default. */
  const route = async (
    method: string,
    params: Record<string, unknown>,
    sessionId: SessionId | undefined,
  ): Promise<string | ToolResult> => {
    const tabId = typeof params.tabId === "number" ? params.tabId : undefined;
    const owner =
      sessionId ?? (tabId !== undefined ? sessions.getTabOwner(tabId as unknown as TabId) : undefined);
    const session = owner !== undefined ? sessions.get(owner) : undefined;
    if (!session) {
      const browser =
        (tabId !== undefined ? await locateTab(tabId) : undefined) ?? deps.browsers.defaultId();
      return browser ?? noBrowserConnected();
    }
    if (method === "adopt_tab" && tabId !== undefined) {
      const holder = await locateTab(tabId);
      if (holder !== undefined && holder !== session.browser) {
        // A session with no tabs yet follows the tab it adopts; one with a group stays put.
        if (session.tabGroupId !== null) return crossBrowserTab(tabId, holder, session.browser);
        sessions.bindBrowser(session.id, holder);
      }
    }
    if (session.browser !== null) return session.browser;
    const fallback = deps.browsers.defaultId();
    if (fallback === undefined) return noBrowserConnected();
    sessions.bindBrowser(session.id, fallback);
    return fallback;
  };

  const listAllTabs = async (options?: TransportRequestOptions): Promise<ToolResult> => {
    const ids = deps.browsers.ids();
    if (ids.length === 0) return noBrowserConnected();
    const results = await Promise.all(ids.map((id) => forwardRaw(id, "list_tabs", {}, options)));
    const tabs: unknown[] = [];
    let failure: ToolResult | undefined;
    results.forEach((res, i) => {
      if (res.ok && Array.isArray(res.result)) {
        tabs.push(...res.result.map((tab) => (isRecord(tab) ? { ...tab, browser: ids[i] } : tab)));
      } else {
        failure ??= res;
      }
    });
    return failure && tabs.length === 0 ? failure : { ok: true, result: tabs };
  };

  const transport: TransportBridge = {
    get isConnected() {
      return deps.browsers.isConnected;
    },
    waitUntilConnected: (signal) => waitForBrowser(undefined, signal),
    selectBrowser(requested) {
      if (requested === undefined) return { ok: true, browser: deps.browsers.defaultId() ?? null };
      const browser = deps.browsers.resolve(requested);
      if (browser !== undefined) return { ok: true, browser };
      const known = deps.browsers
        .list()
        .map((b) => (b.label === b.id ? b.id : `${b.label} (${b.id})`))
        .join(", ");
      return {
        ok: false,
        error: {
          code: "unknown_browser",
          message: `No connected browser matches "${requested}"; ${known ? `connected: ${known}` : "none are connected"}.`,
        },
      };
    },
    async sendToExtension(method, params, options): Promise<ToolResult> {
      if (options?.signal?.aborted) return requestCancelledResult();
      if (method === "__internal_request_consent" && deps.consent) {
        return deps.consent.request(
          params as unknown as ConsentRequestParams,
          async () => {
            const browser = await route(method, params, options?.sessionId);
            return typeof browser === "string" ? forwardRaw(browser, method, params, options) : browser;
          },
          {
            ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          },
        );
      }
      const tabId = typeof params.tabId === "number" ? (params.tabId as unknown as TabId) : undefined;
      // Hold session in-flight for queue wait + execution so the idle reaper can't prune mid-command.
      const owner = tabId !== undefined ? sessions.getTabOwner(tabId) : undefined;
      if (owner) sessions.beginRequest(owner);
      try {
        return await scheduler.submit(
          {
            method,
            ...(typeof params.tabId === "number" ? { tabId: params.tabId } : {}),
            // Session teardown locks all tabs so it can't jump ahead of queued mutations.
            ...(Array.isArray(params.tabIds)
              ? { tabIds: (params.tabIds as unknown[]).filter((n): n is number => typeof n === "number") }
              : {}),
          },
          async () => {
            if (options?.signal?.aborted) return requestCancelledResult();
            // Re-check after queue wait: drop mutators if the session began closing while queued.
            if (
              MUTATING_METHODS.has(method) &&
              tabId !== undefined &&
              sessions.isTabSessionClosing(tabId)
            ) {
              return {
                ok: false,
                error: { code: "session_closing", message: `Session for tab ${params.tabId} is closing.` },
              };
            }
            if (method === "list_tabs" && params.groupId === undefined) return listAllTabs(options);
            const browser = await route(method, params, options?.sessionId);
            if (typeof browser !== "string") return browser;
            return forwardRaw(browser, method, params, options, () => {
              const retrySessionId = options?.sessionId ?? owner;
              if (retrySessionId === undefined) return undefined;
              const session = sessions.get(retrySessionId);
              if (!session || session.closing) {
                return {
                  ok: false,
                  error: {
                    code: "no_session",
                    message: "session ended before the browser read could retry.",
                  },
                };
              }
              if (tabId !== undefined) {
                const ownership = sessions.checkTabOwnership(tabId, retrySessionId);
                if (!ownership.allowed) {
                  return {
                    ok: false,
                    error: {
                      code: "cross_session_tab",
                      message: `tab ${params.tabId} is no longer owned by the session that started this request (${ownership.reason}).`,
                      details: { ownerSessionId: ownership.ownerSessionId },
                    },
                  };
                }
              }
              if (
                typeof params.groupId === "number" &&
                session.tabGroupId !== params.groupId
              ) {
                return {
                  ok: false,
                  error: {
                    code: "cross_session_tab",
                    message: "the session tab group changed before the browser read could retry.",
                  },
                };
              }
              return undefined;
            });
          },
        );
      } finally {
        if (owner) sessions.endRequest(owner);
      }
    },
  };

  const originPolicy =
    deps.originPolicy ??
    (process.env.FN_BROWSER_ORIGIN_POLICY === "remote"
      ? REMOTE_ORIGIN_POLICY
      : PERMISSIVE_ORIGIN_POLICY);

  const server = createBrowserMcpServer({
    bridge: transport,
    originPolicy,
    sessionRegistry: sessions,
    policyStore: policy,
    plugins: createHostToolPlugins(deps.browsers),
  });

  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const req = (await c.req.json()) as JsonRpcRequest;
    const headerSessionId = c.req.header("X-Session-Id") as SessionId | undefined;
    const sessionId = headerSessionId ?? sessionIdFromRequest(req);
    const headerRunId = c.req.header("X-Run-Id");
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;

    // Restore stale ids after restart; authenticated mode requires a signed owner match.
    const canRestore =
      principal === LOCAL_PRINCIPAL ||
      (sessionId !== undefined && sessionIdentity.verifiesOwner(sessionId, principal.id));
    if (sessionId && !sessions.has(sessionId) && canRestore) {
      try {
        sessions.create({
          id: sessionId,
          name: "restored",
          ...(principal !== LOCAL_PRINCIPAL ? { ownerPrincipalId: principal.id } : {}),
        });
      } catch (err) {
        return c.json({
          jsonrpc: "2.0" as const,
          id: req.id ?? null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    const controller = new AbortController();
    const clientSignal = c.req.raw.signal;
    let cancelFromClient!: () => void;
    const clientCancellationResponse = new Promise<JsonRpcResponse>((resolve) => {
      cancelFromClient = () => {
        controller.abort();
        resolve({
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: { code: -32001, message: "request cancelled" },
        });
      };
    });
    clientSignal.addEventListener("abort", cancelFromClient, { once: true });
    if (clientSignal.aborted) cancelFromClient(); // close addEventListener race
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResponse = new Promise<JsonRpcResponse>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve({
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: { code: -32000, message: "request timed out" },
        });
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();
    });

    try {
      const result = await Promise.race([
        handleRequest(
          req,
          server,
          principal,
          sessionId,
          headerRunId,
          controller.signal,
        ),
        timeoutResponse,
        clientCancellationResponse,
      ]);
      return c.json(result);
    } finally {
      if (timeout) clearTimeout(timeout);
      clientSignal.removeEventListener("abort", cancelFromClient);
    }
  });

  return { app, server, sessions, policy };
}

function sessionIdFromRequest(req: JsonRpcRequest): SessionId | undefined {
  if (req.method !== "tools/call") return undefined;
  const args = req.params?.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const sessionId = (args as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? (sessionId as SessionId)
    : undefined;
}

/** Scheduler tuning from env; invalid values fall back to defaults. */
function schedulerConfigFromEnv(): Partial<SchedulerConfig> {
  const config: Partial<SchedulerConfig> = {};
  const inFlight = positiveIntEnv("FN_BROWSER_MAX_INFLIGHT");
  if (inFlight !== undefined) config.maxInFlight = inFlight;
  const queueDepth = positiveIntEnv("FN_BROWSER_MAX_QUEUE_DEPTH");
  if (queueDepth !== undefined) config.maxQueueDepth = queueDepth;
  return config;
}

/** Sanitize run id to a safe path basename; undefined ⇒ caller generates one. */
export function sanitizeRunId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Session idle window (ms) before reaper prunes; default 2h. */
const DEFAULT_DAEMON_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
function sessionIdleMsFromEnv(): number {
  return nonNegativeIntEnv("FN_BROWSER_SESSION_IDLE_MS") ?? DEFAULT_DAEMON_SESSION_IDLE_MS;
}

function nonNegativeIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

async function handleRequest(
  req: JsonRpcRequest,
  server: McpServer,
  principal: Principal,
  sessionId: SessionId | undefined,
  headerRunId: string | undefined,
  signal: AbortSignal,
): Promise<JsonRpcResponse> {
  try {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fn-browser", version: HOST_VERSION },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            tools: server.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case "tools/call": {
        const params = req.params as { name: string; arguments?: Record<string, unknown> };
        const args = params.arguments ?? {};

        const authz = authorizeTool(principal, params.name);
        if (!authz.allowed) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: -32003,
              message: authz.required
                ? `forbidden: tool "${params.name}" requires capability "${authz.required}" (principal "${principal.id}" tier "${principal.tier}")`
                : `forbidden: unknown tool "${params.name}"`,
            },
          };
        }

        // Arg-scoped tier gate; also enforced in the authorize hook for run_flow nodes.
        if (!argScopedTierAllows(params.name, args, principal.tier)) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: -32003,
              message: `forbidden: "${params.name}" with these arguments requires admin (principal "${principal.id}" tier "${principal.tier}")`,
            },
          };
        }

        // X-Run-Id becomes a path component — sanitize to block traversal.
        const runId = sanitizeRunId(headerRunId) ?? RunLog.newRunId();
        const runLog = new RunLog(runId, sessionId);
        const startedAt = performance.now();

        await runLog.append({
          phase: "start",
          tool: params.name,
          at: new Date().toISOString(),
          args: summarize(args),
        });

        const authenticated = principal !== LOCAL_PRINCIPAL;
        const raw = await server.callTool(params.name, args, {
          ...(sessionId ? { sessionId } : {}),
          // Localhost-trust mode leaves sessions unowned (no per-owner cap).
          ...(authenticated ? { principalId: principal.id } : {}),
          authenticated,
          isAdmin: principal.tier === "admin",
          signal,
          authorize: (toolName, toolArgs) =>
            authorizeTool(principal, toolName).allowed &&
            argScopedTierAllows(toolName, toolArgs, principal.tier),
        });

        const transformed = await transformForResponse(params.name, args, raw, {
          runId,
          tabId: typeof args.tabId === "number" ? (args.tabId as number) : undefined,
        });

        await runLog.append({
          phase: "end",
          tool: params.name,
          at: new Date().toISOString(),
          ok: transformed.toolResult.ok,
          durationMs: Math.round(performance.now() - startedAt),
          ...(transformed.toolResult.ok
            ? { result: summarize(transformed.toolResult.result) }
            : {
                errorCode: transformed.toolResult.error.code,
                errorMessage: transformed.toolResult.error.message,
              }),
        });

        if (transformed.toolResult.ok) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: transformed.content,
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: transformed.content,
            isError: true,
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function noBrowserConnected(): ToolResult {
  return {
    ok: false,
    error: {
      code: "extension_unreachable",
      message: "Chrome extension is not connected. Is Chrome open with the fn-browser extension enabled?",
    },
  };
}

function browserUnreachable(browser: string): ToolResult {
  return {
    ok: false,
    error: {
      code: "extension_unreachable",
      message: `Browser ${browser} is not connected. Is that Chrome profile open with the fn-browser extension enabled?`,
    },
  };
}

function crossBrowserTab(tabId: number, holder: string, browser: string | null): ToolResult {
  return {
    ok: false,
    error: {
      code: "cross_browser_tab",
      message: `tab ${tabId} is in browser ${holder} but this session drives ${browser}; start a session with browser "${holder}" to use it.`,
      details: { browser: holder },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requestCancelledResult(): ToolResult {
  return {
    ok: false,
    error: {
      code: "request_cancelled",
      message: "The request deadline elapsed before this browser operation could dispatch.",
    },
  };
}

/** Per-tool response shaping before JSON-RPC; screenshot persists to disk. */
async function transformForResponse(
  toolName: string,
  args: Record<string, unknown>,
  raw: ToolResult,
  ctx: { runId: string; tabId?: number },
): Promise<{ toolResult: ToolResult; content: McpContent[] }> {
  if (!raw.ok) {
    return {
      toolResult: raw,
      content: [
        { type: "text", text: JSON.stringify({ error: raw.error }) },
      ],
    };
  }

  if (toolName === "screenshot") {
    const payload = raw.result as {
      data?: string;
      width?: number;
      height?: number;
    } | null;
    if (payload && typeof payload.data === "string") {
      const inline = args.inline !== false; // default inline; opt out with inline: false
      try {
        const saved = await saveScreenshot(payload.data, {
          runId: ctx.runId,
          ...(typeof ctx.tabId === "number" ? { tabId: ctx.tabId } : {}),
        });

        const meta = {
          ok: true as const,
          path: saved.path,
          fileUrl: saved.fileUrl,
          bytes: saved.bytes,
          ...(payload.width ? { width: payload.width } : {}),
          ...(payload.height ? { height: payload.height } : {}),
        };

        const content: McpContent[] = [
          { type: "text", text: JSON.stringify(meta) },
        ];
        if (inline) {
          content.push({
            type: "image",
            data: payload.data,
            mimeType: "image/png",
          });
        }

        return {
          toolResult: { ok: true, result: meta },
          content,
        };
      } catch (err) {
        const fallback = {
          ok: false as const,
          error: {
            code: "screenshot_persist_failed" as const,
            message: err instanceof Error ? err.message : String(err),
          },
        };
        return {
          toolResult: fallback,
          content: [
            { type: "text", text: JSON.stringify({ error: fallback.error }) },
          ],
        };
      }
    }
  }

  return {
    toolResult: raw,
    content: [{ type: "text", text: JSON.stringify(raw.result) }],
  };
}
