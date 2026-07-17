/**
 * Host commands → chrome.debugger CDP ops + chrome.tabs ops + consent queue.
 *
 * Covers the full fn-browser tool surface. Policy primitives (rate limits,
 * activity window) live in the host, not here — they never reach the
 * extension. We DO handle __internal_request_consent here because consent
 * surfaces in the extension side panel.
 */

import {
  adoptTab,
  browserError,
  type BrowserError,
  BrowserController,
  click,
  createTab,
  evaluateJs,
  fillForm,
  getBrowserError,
  getPageText,
  listTabs,
  navigate,
  observe,
  querySelectorNodeId,
  readConsole,
  readNetwork,
  readPage,
  screenshot,
  describeNode,
  detachTab,
  type GroupInstruction,
  type TabId,
} from "@fntune/browser/cdp";
import type {
  ExtensionToHostError,
  ExtensionToHostResponse,
  HostToExtensionCommand,
} from "../shared/protocol.js";
import { consentQueue } from "./consent-queue.js";
import { hasOrigin } from "./allowlist.js";
import { endSessionGroup, type EndSessionGroupArgs } from "./session-group.js";

export interface CommandRouterDeps {
  sendResponse: (msg: ExtensionToHostResponse | ExtensionToHostError) => void;
}

export function createCommandRouter(deps: CommandRouterDeps) {
  const controller = new BrowserController({
    onTabDetached: async (tabId) => {
      await chrome.tabs
        .sendMessage(tabId as unknown as number, { topic: "overlay:unmount" })
        .catch(() => {
          /* tab may be gone */
        });
    },
  });

  async function handle(cmd: HostToExtensionCommand): Promise<void> {
    try {
      const result = await dispatch(cmd);
      deps.sendResponse({ id: cmd.id, kind: "response", ok: true, result });
    } catch (err) {
      const bErr = getBrowserError(err) ?? toGenericError(err);
      deps.sendResponse({
        id: cmd.id,
        kind: "response",
        ok: false,
        error: { code: bErr.code, message: bErr.message },
      });
    }
  }

  async function dispatch(cmd: HostToExtensionCommand): Promise<unknown> {
    const method = cmd.method as string;
    const p = cmd.params as Record<string, unknown>;

    switch (method) {
      // Policy-queue bridge — consent request from the host. If the host
      // provided a tabId, we resolve its URL → origin so the side-panel
      // modal can anchor the "Always allow on <origin>" option. If the
      // origin is in the user's persisted allowlist, we auto-approve here
      // without ever surfacing the modal.
      case "__internal_request_consent": {
        const { title, body, options, tabId } = p as {
          title: string;
          body: string;
          options?: string[];
          tabId?: number;
        };
        const origin =
          typeof tabId === "number" ? await resolveOrigin(tabId) : undefined;
        if (origin && (await hasOrigin(origin))) {
          return {
            choice: "allow",
            at: new Date().toISOString(),
            autoApproved: true,
            origin,
          };
        }
        return consentQueue.request({
          title,
          body,
          ...(options !== undefined ? { options } : {}),
          ...(origin ? { origin } : {}),
        });
      }

      // Session-lifecycle: closes Chrome tab groups on behalf of the host's
      // SessionRegistry. Group *creation* is lazy — it happens inside create_tab
      // / adopt_tab when the session acquires its first tab.
      case "__internal_end_session_group":
        return endSessionGroup(p as unknown as EndSessionGroupArgs);

      // File input / uploads
      case "upload_file": {
        return controller.uploadFile(extractUploadArgs(p));
      }

      // Navigation
      case "navigate": {
        return navigate({
          tabId: p.tabId as TabId,
          url: p.url as string,
          waitUntil: p.waitUntil as "load" | "domcontentloaded" | undefined,
          timeoutMs: p.timeoutMs as number | undefined,
        });
      }

      // Content
      case "read_page":
        return readPage({ tabId: p.tabId as TabId });
      case "get_page_text":
        return getPageText({ tabId: p.tabId as TabId });
      case "screenshot":
        return screenshot({
          tabId: p.tabId as TabId,
          fullPage: p.full_page as boolean | undefined,
          clip: p.clip as { x: number; y: number; width: number; height: number } | undefined,
        });

      // Interaction
      case "click":
        return click({
          tabId: p.tabId as TabId,
          selector: p.selector as string | undefined,
          ref: p.ref as string | undefined,
          destructive: p.destructive as boolean | undefined,
          humanPace: p.human_pace as boolean | undefined,
          reason: p.reason as string | undefined,
        });
      case "fill_form":
        return fillForm({
          tabId: p.tabId as TabId,
          fields: p.fields as Array<{ selector?: string; ref?: string; value: string | string[] }>,
          destructive: p.destructive as boolean | undefined,
          humanPace: p.human_pace as boolean | undefined,
        });
      case "find":
        return handleFind(p.tabId as TabId, p.selector as string);
      case "observe":
        return observe({
          tabId: p.tabId as TabId,
          query: p.query as string,
          scope: p.scope as "all" | "interactive" | undefined,
        });
      case "evaluate_js":
        return evaluateJs({
          tabId: p.tabId as TabId,
          expression: p.expression as string,
          awaitPromise: p.await_promise as boolean | undefined,
          destructive: p.destructive as boolean | undefined,
        });

      // Tabs
      case "list_tabs":
        return listTabs({
          groupId: typeof p.groupId === "number" ? p.groupId : undefined,
          windowId: typeof p.windowId === "number" ? p.windowId : undefined,
        });
      case "create_tab":
        return createTab({
          url: p.url as string,
          active: p.active as boolean | undefined,
          windowId: typeof p.windowId === "number" ? p.windowId : undefined,
          group: p.group as GroupInstruction | undefined,
        });
      case "adopt_tab":
        return adoptTab({
          tabId: p.tabId as TabId,
          group: p.group as GroupInstruction,
        });
      case "detach_tab":
        await detachTab(p.tabId as TabId);
        return { ok: true };

      // Monitoring
      case "read_console":
        return readConsole({
          tabId: p.tabId as TabId,
          pattern: p.pattern as string | undefined,
          levels: p.levels as Array<"verbose" | "info" | "warning" | "error"> | undefined,
          limit: p.limit as number | undefined,
        });
      case "read_network":
        return readNetwork({
          tabId: p.tabId as TabId,
          pattern: p.pattern as string | undefined,
          methods: p.methods as string[] | undefined,
          limit: p.limit as number | undefined,
        });

      // Sessions — land with task #25
      case "start":
      case "end":
      case "info":
      case "list_sessions":
        return { pending: true, reason: "session model lands with task #25" };

      default: {
        const err: BrowserError = browserError("cdp_error", {
          cdpCode: 0,
          cdpMessage: `unknown method: ${method}`,
          message: `Command "${method}" is not implemented in the extension.`,
        });
        const e = new Error(err.message);
        (e as Error & { browserError: BrowserError }).browserError = err;
        throw e;
      }
    }
  }

  return { handle, controller };
}

function extractUploadArgs(p: Record<string, unknown>) {
  return {
    tabId: p.tabId as TabId,
    selector: (p.selector as string | undefined) ?? "input[type=file]",
    path: p.path as string,
  };
}

async function handleFind(tabId: TabId, selector: string): Promise<unknown> {
  const nodeId = await querySelectorNodeId(tabId, selector);
  if (nodeId === undefined) {
    const err: BrowserError = browserError("element_not_found", {
      selector,
      message: `element ${selector} not found`,
    });
    const e = new Error(err.message);
    (e as Error & { browserError: BrowserError }).browserError = err;
    throw e;
  }
  const node = await describeNode(tabId, nodeId);
  return {
    nodeId,
    tag: node.nodeName,
    attributes: node.attributes ?? [],
  };
}

function toGenericError(err: unknown): BrowserError {
  const message = err instanceof Error ? err.message : String(err);
  return browserError("cdp_error", {
    cdpCode: 0,
    cdpMessage: message,
    message,
  });
}

/**
 * Look up a tab's URL via chrome.tabs.get and return its origin (scheme +
 * host + port). Returns undefined for chrome:// / chrome-extension:// tabs
 * and anything else we can't turn into a real Origin.
 */
async function resolveOrigin(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return undefined;
    const url = new URL(tab.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
