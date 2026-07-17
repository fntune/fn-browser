/**
 * Tool catalog: typed schemas + permission class per tool. Independent of the
 * MCP server transport — used both by createBrowserMcpServer (native-host) and
 * by any future test-time stub.
 *
 * Tool method names have no redundant prefixes; they're scoped by the MCP
 * server name (`fn-browser`) which already disambiguates.
 */

export type PermissionClass = "read" | "write" | "destructive" | "meta";

export interface ToolSchema {
  name: string;
  description: string;
  permission: PermissionClass;
  /** JSON schema (draft-07-ish) for inputs. Enforced by MCP client. */
  inputSchema: Record<string, unknown>;
}

const schemaObject = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const string = { type: "string" } as const;
const number = { type: "number" } as const;
const boolean = { type: "boolean" } as const;
const sessionIdArg = {
  type: "string",
  description:
    "Session id returned by start. Programmatic clients may also send X-Session-Id.",
} as const;

// tabId is a branded number at the type-system layer; at the JSON schema layer
// it's just number.
const tabIdArg = number;

export const TOOLS: readonly ToolSchema[] = [
  // Sessions
  {
    name: "start",
    description:
      "Create a session and its Chrome tab group. Returns sessionId and tab group info. Pass sessionId on subsequent session-aware MCP calls, or send it as X-Session-Id from programmatic clients.",
    permission: "meta",
    inputSchema: schemaObject({
      name: string,
      color: string,
    }),
  },
  {
    name: "end",
    description:
      "Release a session. on_tabs='leave' (default) keeps the tabs but dissolves the group; 'close' closes the tabs.",
    permission: "meta",
    inputSchema: schemaObject({
      sessionId: sessionIdArg,
      on_tabs: { type: "string", enum: ["leave", "close"] },
    }),
  },
  {
    name: "info",
    description: "Return current session metadata + active runs + rate counters.",
    permission: "meta",
    inputSchema: schemaObject({ sessionId: sessionIdArg }),
  },
  {
    name: "list_sessions",
    description: "List all active sessions across all callers. Consent-gated.",
    permission: "meta",
    inputSchema: schemaObject({}),
  },

  // Tabs
  {
    name: "list_tabs",
    description:
      "List tabs owned by the caller's session by default. scope='all' includes tabs from other sessions plus user tabs (consent-gated).",
    permission: "read",
    inputSchema: schemaObject({
      sessionId: sessionIdArg,
      scope: { type: "string", enum: ["session", "all"] },
    }),
  },
  {
    name: "create_tab",
    description:
      "Open a new tab auto-assigned to the caller's session tab group. Returns tab info.",
    permission: "write",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        url: string,
        active: boolean,
      },
      ["url"],
    ),
  },
  {
    name: "adopt_tab",
    description:
      "Move an existing tab (owned by 'user' or another session) into the caller's session group. Consent-gated.",
    permission: "write",
    inputSchema: schemaObject({ sessionId: sessionIdArg, tabId: tabIdArg }, ["tabId"]),
  },

  // Navigation & content
  {
    name: "navigate",
    description: "Navigate a tab to a URL and wait for load.",
    permission: "write",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tabId: tabIdArg,
        url: string,
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
        timeoutMs: number,
      },
      ["tabId", "url"],
    ),
  },
  {
    name: "read_page",
    description: "Return the full outerHTML of the page + url + title.",
    permission: "read",
    inputSchema: schemaObject({ sessionId: sessionIdArg, tabId: tabIdArg }, ["tabId"]),
  },
  {
    name: "get_page_text",
    description:
      "Return document.body.innerText of the page. Cheaper than read_page for token budget.",
    permission: "read",
    inputSchema: schemaObject({ sessionId: sessionIdArg, tabId: tabIdArg }, ["tabId"]),
  },
  {
    name: "screenshot",
    description:
      "Capture a PNG screenshot. Saves to ~/.fn-browser/screenshots/<date>/ and returns {path, fileUrl, bytes} alongside an inline MCP image block Claude can see immediately — matching claude-in-chrome's ergonomics. The base64 is never written as text. Pass inline:false in automation/workflow loops where per-call vision-token cost matters; the path is always returned. full_page captures beyond the viewport.",
    permission: "read",
    inputSchema: schemaObject({
      sessionId: sessionIdArg,
      tabId: tabIdArg,
      full_page: boolean,
      clip: schemaObject({ x: number, y: number, width: number, height: number }),
      inline: boolean,
    }),
  },

  // Interaction
  {
    name: "find",
    description:
      "Resolve a CSS selector to a short DOM summary (nodeName + a few attributes) without fetching outerHTML.",
    permission: "read",
    inputSchema: schemaObject(
      { sessionId: sessionIdArg, tabId: tabIdArg, selector: string },
      ["tabId", "selector"],
    ),
  },
  {
    name: "observe",
    description:
      "Return compact a11y-tree `ref` handles matching a natural-language query. scope='interactive' (default) or 'all'. Use refs in subsequent click/fill_form/upload_file calls.",
    permission: "read",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tabId: tabIdArg,
        query: string,
        scope: { type: "string", enum: ["all", "interactive"] },
      },
      ["tabId", "query"],
    ),
  },
  {
    name: "click",
    description:
      "Click an element by selector or ref. Set destructive=true for actions that send/submit/pay/post — routes through the consent queue. human_pace=true uses Bézier-jittered paths.",
    permission: "write",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tabId: tabIdArg,
        selector: string,
        ref: string,
        destructive: boolean,
        human_pace: boolean,
        reason: string,
      },
      ["tabId"],
    ),
  },
  {
    name: "fill_form",
    description:
      "Fill multiple fields in one call. Each field has selector|ref and value.",
    permission: "write",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tabId: tabIdArg,
        fields: {
          type: "array",
          items: schemaObject(
            {
              selector: string,
              ref: string,
              value: {
                anyOf: [string, { type: "array", items: string }],
              },
            },
            ["value"],
          ),
        },
        destructive: boolean,
        human_pace: boolean,
      },
      ["tabId", "fields"],
    ),
  },
  {
    name: "upload_file",
    description:
      "Upload a local file to an <input type=file> via CDP DOM.setFileInputFiles. Bypasses page CSP. Fires a trusted change event.",
    permission: "write",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tabId: tabIdArg,
        selector: string,
        ref: string,
        path: string,
      },
      ["tabId", "path"],
    ),
  },

  // Scripting & monitoring
  {
    name: "evaluate_js",
    description:
      "Run a JS expression in the page context. Returns JSON result. destructive=true routes through consent.",
    permission: "destructive",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tabId: tabIdArg,
        expression: string,
        destructive: boolean,
        await_promise: boolean,
      },
      ["tabId", "expression"],
    ),
  },
  {
    name: "read_console",
    description: "Recent Log-domain entries from the page (errors, warnings, security, deprecations).",
    permission: "read",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tabId: tabIdArg,
        pattern: string,
        levels: { type: "array", items: string },
        limit: number,
      },
      ["tabId"],
    ),
  },
  {
    name: "read_network",
    description: "Recent Network-domain entries for the tab.",
    permission: "read",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tabId: tabIdArg,
        pattern: string,
        methods: { type: "array", items: string },
        limit: number,
      },
      ["tabId"],
    ),
  },

  // Platform-policy utilities
  {
    name: "rate_limit_check",
    description:
      "Advisory peek at a rate-limit counter by tag. Returns {allowed, remaining, reset_at, count}. Does not increment — to gate a write, use rate_limit_consume.",
    permission: "meta",
    inputSchema: schemaObject(
      {
        // scope:"session" keys the counter by session, so the caller needs a way
        // to pass it when X-Session-Id isn't available (additionalProperties:false).
        sessionId: sessionIdArg,
        tag: string,
        max: number,
        window: { type: "string", enum: ["minute", "hour", "daily"] },
        scope: { type: "string", enum: ["global", "session"] },
      },
      ["tag", "max", "window"],
    ),
  },
  {
    name: "rate_limit_consume",
    description:
      "Atomic check-and-increment of a rate-limit counter. Returns {allowed, remaining, reset_at}; increments only when allowed. scope defaults to global (shared across sessions).",
    permission: "meta",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        tag: string,
        max: number,
        window: { type: "string", enum: ["minute", "hour", "daily"] },
        scope: { type: "string", enum: ["global", "session"] },
      },
      ["tag", "max", "window"],
    ),
  },
  {
    name: "require_consent",
    description:
      "Block until user responds in the extension side panel. Returns {choice, at}. Caller supplies human-readable title + body.",
    permission: "meta",
    inputSchema: schemaObject(
      {
        sessionId: sessionIdArg,
        title: string,
        body: string,
        options: { type: "array", items: string },
      },
      ["title", "body"],
    ),
  },
  {
    name: "require_tos_acceptance",
    description:
      "One-time-per-session-per-origin ToS consent. Returns immediately if already accepted this session.",
    permission: "meta",
    inputSchema: schemaObject(
      { sessionId: sessionIdArg, origin: string, policy_text: string },
      ["origin", "policy_text"],
    ),
  },
  {
    name: "check_activity_window",
    description:
      "Return {in_window, next_window_at} for the given window spec. Caller supplies start/end/tz.",
    permission: "meta",
    inputSchema: schemaObject(
      {
        start: string,
        end: string,
        tz: string,
      },
      ["start", "end"],
    ),
  },

] as const;

export function getToolByName(name: string): ToolSchema | undefined {
  return TOOLS.find((t) => t.name === name);
}

const REPLAY_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "info",
  "list_tabs",
  "read_page",
  "get_page_text",
  "screenshot",
  "find",
  "observe",
  "read_console",
  "read_network",
  "rate_limit_check",
  "check_activity_window",
]);

/** Whether retrying a tool call can duplicate no state-changing action. */
export function isReplaySafeTool(name: string): boolean {
  return REPLAY_SAFE_TOOL_NAMES.has(name);
}
