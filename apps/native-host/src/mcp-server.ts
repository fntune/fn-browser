/**
 * HTTP MCP endpoint backed by @fntune/browser/mcp's createBrowserMcpServer.
 *
 * The X-Session-Id header is authoritative when present. Clients that cannot
 * set dynamic headers may provide the same id as a tool argument; the boundary
 * normalizes either form before restore, logging, and authorization.
 */

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
} from "@fntune/browser/mcp";
import type { SessionId, TabId } from "@fntune/browser/cdp";
import { createHostToolPlugins } from "./plugins.js";
import type { ExtensionBridge } from "./extension-bridge.js";
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
  bridge: ExtensionBridge;
  /** Daemon-owned consent sink. When set, `__internal_request_consent` routes
   * through it (operator-resolvable); when absent, it forwards straight to the
   * extension (current localhost behavior). */
  consent?: ConsentSink;
  /** SSRF egress policy. The daemon computes this from its exposure/auth mode;
   * when absent, falls back to FN_BROWSER_ORIGIN_POLICY (default permissive). */
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

/**
 * Tab-scoped methods that MUTATE the tab (vs. read-only ones). A queued one is
 * dropped at dispatch if its session began closing while it waited — see the
 * scheduler executor below.
 */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "fill_form",
  "upload_file",
  "evaluate_js",
  "adopt_tab",
]);

/** How long forwardRaw waits for the extension to reconnect before giving up on
 *  the single read-retry. Covers a typical SW respawn+redial+handshake; a longer
 *  outage still surfaces the retryable error for the caller to handle. */
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
  // The daemon OWNS the session registry + policy store (rather than letting
  // createBrowserMcpServer default them internally) so it can re-check
  // session.closing at scheduler-dispatch time and run the idle reaper.
  // Remote agent workflows idle between browser actions far longer than a human
  // session would; a too-short idle window reaps a still-wanted session and the
  // next reused-id call returns `no_session`. Default generous (2h), tunable.
  const sessions = new SessionRegistry(
    undefined,
    undefined,
    sessionIdleMsFromEnv(),
    sessionIdentity.createSessionId,
  );
  const policy = new PolicyStore(sessions);

  const waitUntilConnected = async (signal?: AbortSignal): Promise<boolean> => {
    const deadline = performance.now() + RECONNECT_WAIT_MS;
    while (!deps.bridge.isConnected && !signal?.aborted && performance.now() < deadline) {
      await delay(RECONNECT_POLL_MS);
    }
    return deps.bridge.isConnected && !signal?.aborted;
  };

  const forwardRaw = async (
    method: string,
    params: Record<string, unknown>,
    options?: TransportRequestOptions,
    validateRetry?: () => ToolResult | undefined,
  ): Promise<ToolResult> => {
    if (options?.signal?.aborted) return requestCancelledResult();
    const commandOptions =
      options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined;
    const res = await deps.bridge.sendCommand(method, params, commandOptions);
    if (res.ok) return { ok: true, result: res.result };
    // Bounded hold-and-retry: a brief flap (SW evict→respawn) fast-fails as the
    // retryable extension_unreachable. For idempotent reads, wait briefly for the
    // extension to reconnect and re-dispatch ONCE so the flap is invisible to the
    // caller. Mutating ops are never retried here (at-most-once).
    if (res.error.code === "extension_unreachable" && isReplaySafeTool(method)) {
      if (await waitUntilConnected(options?.signal)) {
        if (options?.signal?.aborted) return requestCancelledResult();
        const invalid = validateRetry?.();
        if (invalid) return invalid;
        const retry = await deps.bridge.sendCommand(method, params, commandOptions);
        if (retry.ok) return { ok: true, result: retry.result };
        return { ok: false, error: retry.error };
      }
    }
    return { ok: false, error: res.error };
  };

  const transport: TransportBridge = {
    get isConnected() {
      return deps.bridge.isConnected;
    },
    waitUntilConnected,
    async sendToExtension(method, params, options): Promise<ToolResult> {
      if (options?.signal?.aborted) return requestCancelledResult();
      // Consent round-trips become daemon-owned (operator-resolvable) when a
      // sink is configured; otherwise they forward straight to the side panel.
      if (method === "__internal_request_consent" && deps.consent) {
        return deps.consent.request(
          params as unknown as ConsentRequestParams,
          () => forwardRaw(method, params, options),
          {
            ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          },
        );
      }
      const tabId = typeof params.tabId === "number" ? (params.tabId as unknown as TabId) : undefined;
      // Hold the owning session "in flight" for the WHOLE submit (queue wait +
      // execution) so the idle reaper can't prune it while a command — one with
      // a long caller-supplied timeout, or one queued behind such an op — is
      // still active and would otherwise dispatch against a now-unowned tab.
      const owner = tabId !== undefined ? sessions.getTabOwner(tabId) : undefined;
      if (owner) sessions.beginRequest(owner);
      try {
        return await scheduler.submit(
          {
            method,
            ...(typeof params.tabId === "number" ? { tabId: params.tabId } : {}),
            // Session teardown locks all its tabs so it can't run ahead of queued
            // per-tab mutations for those tabs.
            ...(Array.isArray(params.tabIds)
              ? { tabIds: (params.tabIds as unknown[]).filter((n): n is number => typeof n === "number") }
              : {}),
          },
          async () => {
            if (options?.signal?.aborted) return requestCancelledResult();
            // Re-check at DISPATCH time (after the per-tab-lane wait): if the
            // owning session began closing while this mutating tab-op was queued,
            // drop it instead of acting on a tab whose group teardown is underway.
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
            return forwardRaw(method, params, options, () => {
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

  // The daemon computes the egress policy from its exposure/auth mode and passes
  // it in. Direct callers (tests / the shim path) fall back to the env switch;
  // FN_BROWSER_ORIGIN_POLICY=remote blocks loopback/private/link-local/metadata.
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
    plugins: createHostToolPlugins(),
  });

  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const req = (await c.req.json()) as JsonRpcRequest;
    const headerSessionId = c.req.header("X-Session-Id") as SessionId | undefined;
    const sessionId = headerSessionId ?? sessionIdFromRequest(req);
    const headerRunId = c.req.header("X-Run-Id");
    // When mounted under the daemon app, the auth middleware has set a
    // principal. When the MCP app is exercised in isolation (tests), default to
    // the local admin principal so capability checks are a no-op.
    const principal = c.get("principal") ?? LOCAL_PRINCIPAL;

    // Turn a stale session id into a minimal session after daemon restart or
    // proxy failover. Local mode trusts its single caller. Authenticated mode
    // restores only ids signed for this principal by a daemon sharing the same
    // signing key; an arbitrary claimed id never reserves cross-tenant state.
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
    // Close the listener-registration race before any deferred work starts.
    if (clientSignal.aborted) cancelFromClient();
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

/**
 * Scheduler tuning from the host environment. Unset/invalid values fall back to
 * the scheduler defaults.
 */
function schedulerConfigFromEnv(): Partial<SchedulerConfig> {
  const config: Partial<SchedulerConfig> = {};
  const inFlight = positiveIntEnv("FN_BROWSER_MAX_INFLIGHT");
  if (inFlight !== undefined) config.maxInFlight = inFlight;
  const queueDepth = positiveIntEnv("FN_BROWSER_MAX_QUEUE_DEPTH");
  if (queueDepth !== undefined) config.maxQueueDepth = queueDepth;
  return config;
}

/**
 * Reduce a caller-supplied run id to a safe path basename: `[A-Za-z0-9_-]` only,
 * capped length. Returns undefined for empty/unusable input so the caller falls
 * back to a generated id.
 */
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

/** Session idle window (ms) before the reaper prunes. Default 2h for the daemon
 *  (remote-agent workloads); override with FN_BROWSER_SESSION_IDLE_MS. */
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

        // Capability gate: the local admin principal passes everything, so this
        // is a no-op for localhost-trust mode and enforces tiers for remote
        // callers (e.g. evaluate_js/upload_file require admin).
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

        // Arg-scoped tier gate (e.g. list_tabs scope:"all" is admin-only). This
        // dispatch check gives direct callers a clean -32003; the same rule is
        // ALSO enforced in the authorize hook below so it covers inner run_flow
        // node calls, which never pass through here.
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

        // X-Run-Id is caller-supplied and becomes a path component
        // (<runId>.jsonl, screenshot filenames), so sanitize it to a safe
        // basename — no `../` traversal out of ~/.fn-browser/runs.
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
          // Only bind a principal in authenticated mode. The local-admin fallback
          // (auth disabled) leaves sessions UNOWNED — single-tenant access to the
          // user's own tabs, and not subject to the per-owner session cap.
          ...(authenticated ? { principalId: principal.id } : {}),
          authenticated,
          // Admin acts as an operator: list_sessions surfaces all principals'
          // sessions, matching the /sessions route.
          isAdmin: principal.tier === "admin",
          signal,
          // Re-checked for every tool, incl. tools called from inside a flow —
          // capability AND arg-scoped tier (so a run_flow browser_list_tabs node
          // with scope:"all" can't bypass the admin gate).
          authorize: (toolName, toolArgs) =>
            authorizeTool(principal, toolName).allowed &&
            argScopedTierAllows(toolName, toolArgs, principal.tier),
        });

        // Screenshots pass through a disk-persistence step that strips the
        // base64 from the tool's JSON result (so it doesn't land in Claude's
        // text context) and optionally returns the image as an MCP image
        // content block when the caller asked for `inline: true`.
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

function requestCancelledResult(): ToolResult {
  return {
    ok: false,
    error: {
      code: "request_cancelled",
      message: "The request deadline elapsed before this browser operation could dispatch.",
    },
  };
}

/**
 * Per-tool response shaping. Runs after `server.callTool` but before we
 * serialize to JSON-RPC. Right now only `screenshot` has a transform: the
 * base64 PNG bytes are moved to disk so they don't balloon Claude's context,
 * and the returned content optionally includes an MCP `image` block when
 * the caller explicitly requested `inline: true`.
 */
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
      // Default to inline so Claude sees the screenshot in-turn without an
      // explicit `Read` step (matching claude-in-chrome's ergonomics). Image
      // content blocks cost vision tokens (~1.5K for a viewport capture), not
      // text tokens. Callers that run automation loops and care about context
      // budget can opt out with `inline: false`.
      const inline = args.inline !== false;
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

        // Strip `data` from the result we return to workflow nodes / other
        // in-process callers; they get the same path-based metadata.
        return {
          toolResult: { ok: true, result: meta },
          content,
        };
      } catch (err) {
        // Persistence failed — fall through to the default behaviour so the
        // caller still gets the base64. This is a soft degradation.
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
