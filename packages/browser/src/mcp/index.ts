/**
 * createBrowserMcpServer — factory used by apps/native-host/src/main.ts.
 *
 * Exposes the full tool surface defined in tool-catalog.ts. Each tool call is
 * routed through an abstract TransportBridge (the native host plugs in the
 * extension bridge; tests plug in a stub). Platform-policy tools (rate_limit,
 * consent, activity window) and session tools (start/end/info/list_sessions)
 * resolve in-host; extension-backed tools round-trip through the bridge.
 */

import { PolicyStore } from "./policy-store.js";
import { SessionRegistry, type Session } from "./session-registry.js";
import {
  evaluateNavigationTarget,
  PERMISSIVE_ORIGIN_POLICY,
  type OriginPolicy,
} from "./origin-policy.js";
import {
  getToolByName,
  isReplaySafeTool,
  TOOLS,
  type ToolSchema,
} from "./tool-catalog.js";
import type { SessionId, TabId, ChromeTabGroupColor } from "../cdp/types.js";
import { isChromeTabGroupColor } from "../cdp/types.js";
import type { GroupInstruction } from "../cdp/tabs.js";

export { isReplaySafeTool };

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface TransportRequestOptions {
  timeoutMs?: number;
  /** Abort before a deferred operation reaches Chrome (for example after HITL). */
  signal?: AbortSignal;
  /** Owning session to revalidate before a deferred/retried dispatch. */
  sessionId?: SessionId;
}

export type BrowserSelection =
  | { ok: true; browser: string | null }
  | { ok: false; error: { code: string; message: string } };

export interface TransportBridge {
  sendToExtension(
    method: string,
    params: Record<string, unknown>,
    options?: TransportRequestOptions,
  ): Promise<ToolResult>;
  readonly isConnected: boolean;
  /** Optional bounded reconnect wait used only for replay-safe tools. */
  waitUntilConnected?(signal?: AbortSignal): Promise<boolean>;
  /**
   * Pick the browser (Chrome profile) a new session drives; `requested` is the
   * caller's `browser` argument. `browser: null` defers the choice to first use.
   */
  selectBrowser?(requested: string | undefined): BrowserSelection;
}

export interface CallToolContext {
  /**
   * Session id supplied by the MCP client via X-Session-Id header. MCP clients
   * that cannot set dynamic headers may pass the same id as a `sessionId` tool
   * argument; the server normalizes both at the boundary.
   */
  sessionId?: SessionId;
  /**
   * Authenticated principal id (set by the daemon in authenticated mode).
   * Sessions are bound to their owning principal; a caller may only reference a
   * session it owns. Undefined in single-tenant / unauthenticated use, where
   * ownership is not enforced.
   */
  principalId?: string;
  /** Per-tool auth gate; also applies to plugin re-entries via `callTool`. Undefined ⇒ no gating. */
  authorize?: (toolName: string, args: Record<string, unknown>) => boolean;
  /** True in authenticated daemon mode; enforces session ownership on tab ops. */
  authenticated?: boolean;
  /** True for admin principals; `list_sessions` sees all sessions. */
  isAdmin?: boolean;
  /** Request lifetime. Once aborted, no deferred browser operation may dispatch. */
  signal?: AbortSignal;
}

export interface McpServerOptions {
  bridge: TransportBridge;
  policyStore?: PolicyStore;
  sessionRegistry?: SessionRegistry;
  /**
   * SSRF / egress policy gating create_tab + navigate. Defaults to permissive
   * (current localhost behavior); the daemon tightens it for remote callers.
   */
  originPolicy?: OriginPolicy;
  /** Extra catalog tools; same auth/session gates as built-ins. Duplicate names throw. */
  plugins?: readonly McpToolPlugin[];
}

export interface McpToolPlugin {
  /** Schema surfaced through `McpServer.tools` next to the built-in catalog. */
  tool: ToolSchema;
  handler(
    args: Record<string, unknown>,
    context: CallToolContext | undefined,
    server: McpServer,
  ): Promise<ToolResult>;
}

export interface McpServer {
  readonly tools: readonly ToolSchema[];
  readonly sessions: SessionRegistry;
  readonly policy: PolicyStore;
  callTool(
    name: string,
    args: Record<string, unknown>,
    context?: CallToolContext,
  ): Promise<ToolResult>;
}

const SESSION_TOOLS: ReadonlySet<string> = new Set(["start", "end", "info", "list_sessions"]);

const HOST_POLICY_TOOLS: ReadonlySet<string> = new Set([
  "rate_limit_check",
  "rate_limit_consume",
  "require_consent",
  "require_tos_acceptance",
  "check_activity_window",
]);

const EXTENSION_BACKED_TOOLS: ReadonlySet<string> = new Set([
  "list_tabs",
  "create_tab",
  "adopt_tab",
  "navigate",
  "read_page",
  "get_page_text",
  "screenshot",
  "find",
  "observe",
  "click",
  "fill_form",
  "upload_file",
  "evaluate_js",
  "read_console",
  "read_network",
]);

/**
 * Tools that take a `tabId` argument, so we can gate them on session
 * ownership.
 */
const TAB_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "navigate",
  "read_page",
  "get_page_text",
  "screenshot",
  "find",
  "observe",
  "click",
  "fill_form",
  "upload_file",
  "evaluate_js",
  "read_console",
  "read_network",
]);

/** Tools that honor `destructive: true` via the consent queue before CDP dispatch. */
const CONSENT_GATED_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "fill_form",
  "evaluate_js",
]);

export function createBrowserMcpServer(options: McpServerOptions): McpServer {
  const sessions = options.sessionRegistry ?? new SessionRegistry();
  // PolicyStore needs the registry to honor session.policy during requireConsent.
  const policy = options.policyStore ?? new PolicyStore(sessions);
  const originPolicy = options.originPolicy ?? PERMISSIVE_ORIGIN_POLICY;

  const plugins = new Map<string, McpToolPlugin>();
  for (const plugin of options.plugins ?? []) {
    if (getToolByName(plugin.tool.name) || plugins.has(plugin.tool.name)) {
      throw new Error(`duplicate MCP tool name: ${plugin.tool.name}`);
    }
    plugins.set(plugin.tool.name, plugin);
  }
  const tools: readonly ToolSchema[] =
    plugins.size === 0 ? TOOLS : [...TOOLS, ...[...plugins.values()].map((p) => p.tool)];

  const server: McpServer = {
    tools,
    sessions,
    policy,
    async callTool(name, args, context): Promise<ToolResult> {
      const callContext = normalizeContext(args, context);
      if (callContext?.signal?.aborted) return requestCancelledResult();
      const tool = getToolByName(name) ?? plugins.get(name)?.tool;
      if (!tool) {
        return { ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${name}` } };
      }

      // Auth gate on every call, including plugin re-entries via callTool.
      if (callContext?.authorize && !callContext.authorize(name, args)) {
        return {
          ok: false,
          error: { code: "forbidden", message: `tool ${name} is not permitted for this caller.` },
        };
      }

      // Session impersonation guard (authenticated mode only).
      if (callContext?.sessionId && callContext.principalId) {
        const owner = sessions.ownerPrincipalId(callContext.sessionId);
        if (owner !== undefined && owner !== null && owner !== callContext.principalId) {
          return {
            ok: false,
            error: {
              code: "forbidden",
              message: `session ${callContext.sessionId} is not owned by your principal.`,
            },
          };
        }
      }

      // Bump idle clock on every session-scoped call (most tab ops skip get()).
      if (callContext?.sessionId) sessions.touch(callContext.sessionId);

      if (SESSION_TOOLS.has(name)) {
        return handleSessionTool(name, args, callContext, sessions, options.bridge);
      }

      if (HOST_POLICY_TOOLS.has(name)) {
        return handleHostTool(name, args, policy, options.bridge, callContext);
      }

      const plugin = plugins.get(name);
      if (plugin) {
        return plugin.handler(args, callContext, server);
      }

      if (EXTENSION_BACKED_TOOLS.has(name)) {
        const connected =
          options.bridge.isConnected ||
          (isReplaySafeTool(name) &&
            options.bridge.waitUntilConnected !== undefined &&
            (await options.bridge.waitUntilConnected(callContext?.signal)));
        if (callContext?.signal?.aborted) return requestCancelledResult();
        if (!connected) {
          return {
            ok: false,
            error: {
              code: "extension_unreachable",
              message:
                "Chrome extension is not connected. Is Chrome open with the fn-browser extension enabled?",
            },
          };
        }

        if (name === "list_tabs") {
          return handleListTabs(args, callContext, sessions, policy, options.bridge);
        }

        const callerSessionId = callContext?.sessionId;
        if (TAB_SCOPED_TOOLS.has(name)) {
          const tabId = args.tabId as TabId | undefined;
          if (tabId !== undefined) {
            if (callContext?.authenticated) {
              // Authenticated mode: tab ops require a caller-owned session.
              if (!callerSessionId) {
                return noSessionResult(
                  `tab ${tabId} requires a session; pass sessionId or X-Session-Id (no access to unowned tabs).`,
                );
              }
              const check = sessions.checkTabOwnership(tabId, callerSessionId);
              if (!check.allowed) {
                return {
                  ok: false,
                  error: {
                    code: "cross_session_tab",
                    message: `tab ${tabId} is not in your session's tab group (${check.reason}).`,
                    details: { ownerSessionId: check.ownerSessionId },
                  },
                };
              }
            } else {
              // Unauthenticated: unowned tabs OK; other sessions' tabs are not.
              if (!callerSessionId && sessions.getTabOwner(tabId)) {
                return noSessionResult(
                  `tab ${tabId} belongs to a browser session; pass sessionId or X-Session-Id to access it.`,
                );
              }
              if (callerSessionId) {
                const check = sessions.checkTabOwnership(tabId, callerSessionId);
                if (!check.allowed) {
                  return {
                    ok: false,
                    error: {
                      code: "cross_session_tab",
                      message: `tab ${tabId} is not in your session's tab group (${check.reason}).`,
                      details: { ownerSessionId: check.ownerSessionId },
                    },
                  };
                }
              }
            }
          }
        }

        let targetSession:
          | ReturnType<SessionRegistry["get"]>
          | undefined;
        if (name === "create_tab" || name === "adopt_tab") {
          if (!callerSessionId) {
            return noSessionResult(
              `sessionId argument or X-Session-Id header is required to call '${name}'.`,
            );
          }
          targetSession = sessions.get(callerSessionId);
          if (!targetSession) {
            return noSessionResult("session not found (may have timed out)");
          }
          if (targetSession.closing) {
            return noSessionResult("session is closing");
          }
        }

        // adopt_tab: block cross-principal tab theft in authenticated mode.
        if (name === "adopt_tab" && callContext?.authenticated) {
          const tabId = args.tabId as TabId | undefined;
          if (tabId !== undefined) {
            const ownerSession = sessions.getTabOwner(tabId);
            if (
              ownerSession &&
              ownerSession !== callerSessionId &&
              sessions.ownerPrincipalId(ownerSession) !== callContext.principalId
            ) {
              return {
                ok: false,
                error: {
                  code: "cross_session_tab",
                  message: `tab ${tabId} is owned by another principal's session; cannot adopt it.`,
                  details: { ownerSessionId: ownerSession },
                },
              };
            }
          }
        }

        if (name === "adopt_tab") {
          // Unowned user tab in authenticated mode: always prompt (destructive, localOnly).
          const adoptTabId = args.tabId as TabId | undefined;
          const adoptingUnownedUserTab =
            callContext?.authenticated === true &&
            adoptTabId !== undefined &&
            !sessions.getTabOwner(adoptTabId);
          const consent = await policy.requireConsent({
            title: "Adopt tab into browser session",
            body: consentBodyFor(name, args),
            options: ["allow", "deny"],
            bridge: options.bridge,
            sessionId: callerSessionId,
            destructive: adoptingUnownedUserTab,
            localOnly: adoptingUnownedUserTab,
            signal: callContext?.signal,
            // Omit tabId when force-prompting so origin allowlist can't auto-approve.
            ...(typeof args.tabId === "number" && !adoptingUnownedUserTab
              ? { tabId: args.tabId }
              : {}),
          });
          if (callContext?.signal?.aborted) return requestCancelledResult();
          if (consent.choice !== "allow") {
              return {
                ok: false,
                error: {
                  code: "consent_denied",
                  message: `User denied consent for ${name} (choice: ${consent.choice})`,
                },
              };
          }
        }

        if (name === "create_tab") {
          const url = args.url;
          if (typeof url !== "string" || url.length === 0) {
            return {
              ok: false,
              error: { code: "invalid_argument", message: "create_tab requires a non-empty url." },
            };
          }
        }

        // SSRF / egress gate: create_tab + navigate must clear the origin policy
        // before the target reaches the browser.
        if ((name === "create_tab" || name === "navigate") && typeof args.url === "string") {
          const decision = evaluateNavigationTarget(args.url, originPolicy);
          if (!decision.allowed) {
            return {
              ok: false,
              error: {
                code: "navigation_blocked",
                message: decision.reason ?? `navigation to ${args.url} is blocked by policy`,
                details: { classification: decision.classification },
              },
            };
          }
        }

        // Destructive actions always prompt regardless of session policy.
        if (CONSENT_GATED_TOOLS.has(name) && args.destructive === true) {
          const consent = await policy.requireConsent({
            title: consentTitleFor(name, args),
            body: consentBodyFor(name, args),
            options: ["allow", "deny"],
            bridge: options.bridge,
            sessionId: callerSessionId,
            destructive: true,
            signal: callContext?.signal,
            ...(typeof args.tabId === "number" ? { tabId: args.tabId } : {}),
          });
          if (callContext?.signal?.aborted) return requestCancelledResult();
          if (consent.choice !== "allow") {
            return {
              ok: false,
              error: {
                code: "consent_denied",
                message: `User denied consent for ${name} (choice: ${consent.choice})`,
              },
            };
          }
        }

        if ((name === "create_tab" || name === "adopt_tab") && targetSession) {
          return runSessionTabOp(
            name,
            args,
            targetSession,
            sessions,
            options.bridge,
            callContext?.signal,
          );
        }

        // Re-check ownership after consent await (concurrent end() may un-own the tab).
        if (TAB_SCOPED_TOOLS.has(name) && callContext?.authenticated && callerSessionId) {
          const tabId = args.tabId as TabId | undefined;
          if (tabId !== undefined) {
            const recheck = sessions.checkTabOwnership(tabId, callerSessionId);
            if (!recheck.allowed) {
              return {
                ok: false,
                error: {
                  code: "cross_session_tab",
                  message: `tab ${tabId} left your session while awaiting consent (${recheck.reason}).`,
                  details: { ownerSessionId: recheck.ownerSessionId },
                },
              };
            }
          }
        }

        return options.bridge.sendToExtension(
          name,
          stripRoutingArgs(args),
          bridgeOptionsFor(name, args, callContext?.signal, callContext?.sessionId),
        );
      }

      return {
        ok: false,
        error: { code: "unknown_tool", message: `Tool ${name} has no registered handler.` },
      };
    },
  };

  return server;
}

function normalizeContext(
  args: Record<string, unknown>,
  context: CallToolContext | undefined,
): CallToolContext | undefined {
  if (context?.sessionId) return context;
  // Carry principalId (and any other context) when sourcing sessionId from args.
  if (typeof args.sessionId === "string" && args.sessionId.length > 0) {
    return { ...context, sessionId: args.sessionId as SessionId };
  }
  return context;
}

/**
 * Per-tool bridge timeouts above the host backstop (~20s) for long-running ops.
 */
function bridgeOptionsFor(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  sessionId?: SessionId,
): TransportRequestOptions | undefined {
  let timeoutMs: number | undefined;
  if (name === "navigate") {
    const requested = typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
    timeoutMs = requested + 5_000;
  } else if (name === "evaluate_js") {
    timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
  }
  // Long ops can exceed the 20s default; premature timeout frees the lane for retry.
  if (name === "screenshot" && args.full_page === true) {
    timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
  } else if (name === "upload_file") {
    timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
  }
  // human_pace can exceed the 20s default on long forms.
  if (name === "fill_form") {
    timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
  }
  if (timeoutMs === undefined && signal === undefined && sessionId === undefined) return undefined;
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function stripRoutingArgs(args: Record<string, unknown>): Record<string, unknown> {
  const forwarded = { ...args };
  delete forwarded.sessionId;
  delete forwarded.traceId;
  delete forwarded.runId;
  return forwarded;
}

/**
 * Forward create_tab/adopt_tab and reconcile tab-group ownership.
 * First tab lazily creates the group under a per-session mutex.
 */
async function runSessionTabOp(
  name: "create_tab" | "adopt_tab",
  args: Record<string, unknown>,
  session: Session,
  sessions: SessionRegistry,
  bridge: TransportBridge,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const forwardAndBind = async (): Promise<ToolResult> => {
    if (signal?.aborted) return requestCancelledResult();
    // Re-read inside the lock — session may have ended while queued.
    const live = sessions.get(session.id);
    if (!live) return noSessionResult("session not found (may have timed out)");
    if (live.closing) return noSessionResult("session is closing");

    // Re-check cross-principal ownership before Chrome mutation (adopt_tab).
    if (name === "adopt_tab") {
      const tid = args.tabId as TabId | undefined;
      if (tid !== undefined) {
        const owner = sessions.getTabOwner(tid);
        if (
          owner &&
          owner !== live.id &&
          sessions.ownerPrincipalId(owner) !== live.ownerPrincipalId
        ) {
          return {
            ok: false,
            error: {
              code: "cross_session_tab",
              message: `tab ${tid} is owned by another principal's session.`,
              details: { ownerSessionId: owner },
            },
          };
        }
      }
    }

    const currentGroup = live.tabGroupId;
    const needsGroup = currentGroup === null;
    const group: GroupInstruction =
      currentGroup === null
        ? { create: { name: live.name, color: live.color } }
        : { id: currentGroup };

    const base = stripRoutingArgs(args);
    const forwardedArgs =
      name === "create_tab"
        ? { ...base, ...(live.windowId !== null ? { windowId: live.windowId } : {}), group }
        : { ...base, group };

    const result = await bridge.sendToExtension(name, forwardedArgs, {
      signal,
      sessionId: live.id,
    });
    if (!result.ok) return result;

    const tab = result.result as { id?: number; groupId?: number; windowId?: number };
    if (!tab || typeof tab.id !== "number") {
      return {
        ok: false,
        error: { code: "invalid_extension_result", message: `${name} returned no tab id.` },
      };
    }

    if (needsGroup) {
      // TAB_GROUP_ID_NONE (-1) would reconcile every ungrouped tab into this session.
      if (typeof tab.groupId !== "number" || tab.groupId <= 0 || typeof tab.windowId !== "number") {
        return {
          ok: false,
          error: {
            code: "session_group_not_created",
            message: `${name} returned tab ${tab.id} without a valid Chrome group (groupId ${String(tab.groupId)}).`,
          },
        };
      }
      sessions.bindTabGroup(live.id, tab.groupId, tab.windowId);
    } else if (tab.groupId !== live.tabGroupId) {
      return {
        ok: false,
        error: {
          code: "session_group_mismatch",
          message: `${name} returned tab ${tab.id} in group ${String(tab.groupId)} instead of session group ${String(live.tabGroupId)}.`,
        },
      };
    }

    // Attach even if closing so end()'s snapshot closes the tab (no orphan).
    // TOCTOU: another principal may have adopted the tab during sendToExtension.
    const currentOwner = sessions.getTabOwner(tab.id as unknown as TabId);
    if (
      currentOwner &&
      currentOwner !== live.id &&
      sessions.ownerPrincipalId(currentOwner) !== live.ownerPrincipalId
    ) {
      return {
        ok: false,
        error: {
          code: "cross_session_tab",
          message: `tab ${tab.id} was adopted by another principal first.`,
          details: { ownerSessionId: currentOwner },
        },
      };
    }
    sessions.attachTab(live.id, tab.id as unknown as TabId);
    return result;
  };

  // Session lock serializes create/adopt vs end(); adopt_tab also takes the tab lock.
  const sessionOp = (): Promise<ToolResult> =>
    sessions.runSessionExclusive(session.id, forwardAndBind);
  const adoptTabId = args.tabId as TabId | undefined;
  // Hold in-flight across the queued op so idle reaper won't prune before attach.
  sessions.beginRequest(session.id);
  try {
    return await (name === "adopt_tab" && adoptTabId !== undefined
      ? sessions.runTabExclusive(adoptTabId, sessionOp)
      : sessionOp());
  } finally {
    sessions.endRequest(session.id);
  }
}

function noSessionResult(message: string): ToolResult {
  return { ok: false, error: { code: "no_session", message } };
}

async function handleListTabs(
  args: Record<string, unknown>,
  context: CallToolContext | undefined,
  sessions: SessionRegistry,
  policy: PolicyStore,
  bridge: TransportBridge,
): Promise<ToolResult> {
  const scope = args.scope === "all" ? "all" : "session";

  if (scope === "all") {
    const consent = await policy.requireConsent({
      title: "List all browser tabs",
      body: "Allow fn-browser to list tabs outside the current session.",
      options: ["allow", "deny"],
      bridge,
      sessionId: context?.sessionId,
      destructive: false,
      signal: context?.signal,
    });
    if (context?.signal?.aborted) return requestCancelledResult();
    if (consent.choice !== "allow") {
      return {
        ok: false,
        error: {
          code: "consent_denied",
          message: `User denied consent for list_tabs (choice: ${consent.choice})`,
        },
      };
    }
    return bridge.sendToExtension("list_tabs", {}, { signal: context?.signal });
  }

  if (!context?.sessionId) {
    return noSessionResult(
      "sessionId argument or X-Session-Id header is required to list session tabs.",
    );
  }
  const session = sessions.get(context.sessionId);
  if (!session) {
    return noSessionResult("session not found (may have timed out)");
  }
  // Null groupId would coerce to an all-tabs query in the extension.
  if (session.tabGroupId === null) {
    return { ok: true, result: [] };
  }
  return bridge.sendToExtension(
    "list_tabs",
    {
      groupId: session.tabGroupId,
      windowId: session.windowId,
    },
    { signal: context.signal, sessionId: context.sessionId },
  );
}

async function handleSessionTool(
  name: string,
  args: Record<string, unknown>,
  context: CallToolContext | undefined,
  sessions: SessionRegistry,
  bridge: TransportBridge,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "start": {
        // Validate color before first tab groups — invalid color fails tabGroups.update late.
        if (args.color !== undefined && !isChromeTabGroupColor(args.color)) {
          return {
            ok: false,
            error: {
              code: "invalid_argument",
              message: `invalid color "${String(args.color)}" (expected one of: grey, blue, red, yellow, green, pink, purple, cyan, orange)`,
            },
          };
        }
        const requested =
          typeof args.browser === "string" && args.browser.length > 0 ? args.browser : undefined;
        const selection = bridge.selectBrowser?.(requested) ?? { ok: true, browser: null };
        if (!selection.ok) return selection;
        const session = sessions.start({
          name: args.name as string | undefined,
          color: args.color as ChromeTabGroupColor | undefined,
          browser: selection.browser,
          ...(context?.principalId ? { ownerPrincipalId: context.principalId } : {}),
        });
        return {
          ok: true,
          result: {
            sessionId: session.id,
            name: session.name,
            color: session.color,
            browser: session.browser,
            tabGroupId: session.tabGroupId,
            windowId: session.windowId,
          },
        };
      }
      case "end": {
        if (!context?.sessionId) {
          return noSessionResult(
            "sessionId argument or X-Session-Id header is required to call 'end'.",
          );
        }
        const onTabs = (args.on_tabs as "leave" | "close" | undefined) ?? "leave";
        return {
          ok: true,
          result: await sessions.end({ sessionId: context.sessionId, onTabs, bridge }),
        };
      }
      case "info": {
        if (!context?.sessionId) {
          return noSessionResult(
            "sessionId argument or X-Session-Id header is required to call 'info'.",
          );
        }
        const session = sessions.get(context.sessionId);
        if (!session) {
          return {
            ok: false,
            error: { code: "no_session", message: "session not found (may have timed out)" },
          };
        }
        return {
          ok: true,
          result: {
            sessionId: session.id,
            name: session.name,
            color: session.color,
            browser: session.browser,
            tabGroupId: session.tabGroupId,
            windowId: session.windowId,
            createdAt: session.createdAt.toISOString(),
            lastHeartbeat: session.lastHeartbeat.toISOString(),
            ownedTabs: Array.from(session.ownedTabs),
            workflowRunIds: session.workflowRunIds,
            policy: session.policy,
          },
        };
      }
      case "list_sessions": {
        // Authenticated: own sessions only; admin/unauthenticated see all.
        const callerPrincipalId = context?.principalId;
        const visible = sessions
          .list()
          .filter(
            (s) =>
              !callerPrincipalId ||
              context?.isAdmin === true ||
              s.ownerPrincipalId === null ||
              s.ownerPrincipalId === callerPrincipalId,
          );
        return {
          ok: true,
          result: {
            sessions: visible.map((s) => ({
              sessionId: s.id,
              name: s.name,
              color: s.color,
              browser: s.browser,
              tabGroupId: s.tabGroupId,
              createdAt: s.createdAt.toISOString(),
              lastHeartbeat: s.lastHeartbeat.toISOString(),
              ownedTabCount: s.ownedTabs.size,
            })),
          },
        };
      }
      default:
        return { ok: false, error: { code: "unknown_tool", message: name } };
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "session_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function handleHostTool(
  name: string,
  args: Record<string, unknown>,
  policy: PolicyStore,
  bridge: TransportBridge,
  context: CallToolContext | undefined,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "rate_limit_check": {
        const { tag, max, window, scope } = args as {
          tag: string;
          max: number;
          window: string;
          scope?: "global" | "session";
        };
        return {
          ok: true,
          result: await policy.rateLimitCheck(tag, max, window, {
            ...(scope ? { scope } : {}),
            ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
          }),
        };
      }
      case "rate_limit_consume": {
        const { tag, max, window, scope } = args as {
          tag: string;
          max: number;
          window: string;
          scope?: "global" | "session";
        };
        return {
          ok: true,
          result: await policy.rateLimitConsume(tag, max, window, {
            ...(scope ? { scope } : {}),
            ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
          }),
        };
      }
      case "require_consent": {
        const { title, body, options, destructive } = args as {
          title: string;
          body: string;
          options?: string[];
          destructive?: boolean;
        };
        return {
          ok: true,
          result: await policy.requireConsent({
            title,
            body,
            options,
            bridge,
            sessionId: context?.sessionId,
            destructive: destructive ?? false,
            signal: context?.signal,
          }),
        };
      }
      case "require_tos_acceptance": {
        const { origin, policy_text } = args as { origin: string; policy_text: string };
        return {
          ok: true,
          result: await policy.requireTosAcceptance({
            origin,
            policyText: policy_text,
            bridge,
            sessionId: context?.sessionId,
            signal: context?.signal,
          }),
        };
      }
      case "check_activity_window": {
        const { start, end, tz } = args as { start: string; end: string; tz?: string };
        return { ok: true, result: policy.checkActivityWindow({ start, end, tz }) };
      }
      default:
        return { ok: false, error: { code: "unknown_tool", message: name } };
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "host_error",
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

export { PolicyStore } from "./policy-store.js";
export { SessionRegistry, type Session } from "./session-registry.js";
export type { ToolSchema, PermissionClass } from "./tool-catalog.js";
export { TOOLS, getToolByName } from "./tool-catalog.js";
export {
  classifyHost,
  evaluateNavigationTarget,
  PERMISSIVE_ORIGIN_POLICY,
  REMOTE_ORIGIN_POLICY,
  type OriginPolicy,
  type HostClassification,
  type NavigationDecision,
} from "./origin-policy.js";

function consentTitleFor(tool: string, args: Record<string, unknown>): string {
  const reason = typeof args.reason === "string" ? args.reason : undefined;
  if (reason) return reason;
  switch (tool) {
    case "click":
      return "Confirm destructive click";
    case "fill_form":
      return "Confirm destructive form submission";
    case "evaluate_js":
      return "Confirm JS execution";
    default:
      return `Confirm ${tool}`;
  }
}

function consentBodyFor(tool: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (args.tabId !== undefined) parts.push(`tab ${args.tabId}`);
  if (args.selector) parts.push(`selector ${args.selector}`);
  if (args.ref) parts.push(`ref ${args.ref}`);
  if (tool === "evaluate_js" && typeof args.expression === "string") {
    const preview = args.expression.slice(0, 200);
    parts.push(`JS: ${preview}${args.expression.length > 200 ? "…" : ""}`);
  }
  if (tool === "fill_form" && Array.isArray(args.fields)) {
    parts.push(`${args.fields.length} field(s)`);
  }
  return parts.join(" · ") || "Destructive action pending approval.";
}

