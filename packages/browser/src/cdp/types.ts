/**
 * Shared types for @fntune/browser. Safe to import from both the Chrome extension
 * (which has chrome.* runtime) and the Bun native host (which does not).
 */

export type SessionId = string & { readonly __brand: "SessionId" };
export type TabId = number & { readonly __brand: "TabId" };
export type RunId = string & { readonly __brand: "RunId" };

export type HitlMode = "ask" | "follow_plan" | "act";

export type ChromeTabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export const CHROME_TAB_GROUP_COLORS: readonly ChromeTabGroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

export function isChromeTabGroupColor(value: unknown): value is ChromeTabGroupColor {
  return typeof value === "string" && (CHROME_TAB_GROUP_COLORS as readonly string[]).includes(value);
}

export interface TabInfo {
  id: TabId;
  url: string;
  title: string;
  windowId: number;
  groupId: number;
  active: boolean;
}

export interface BrowserActionMeta {
  sessionId?: SessionId;
  traceId?: string;
  runId?: RunId;
}

export interface UploadArgs extends BrowserActionMeta {
  tabId: TabId;
  selector: string;
  path: string;
}

export interface ClickArgs extends BrowserActionMeta {
  tabId: TabId;
  selector?: string;
  ref?: string;
  destructive?: boolean;
  humanPace?: boolean;
  reason?: string;
}

export interface FillFormArgs extends BrowserActionMeta {
  tabId: TabId;
  fields: Array<{ selector?: string; ref?: string; value: string | string[] }>;
  destructive?: boolean;
  humanPace?: boolean;
}

export interface NavigateArgs extends BrowserActionMeta {
  tabId: TabId;
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
}

export interface ObserveArgs extends BrowserActionMeta {
  tabId: TabId;
  query: string;
  scope?: "all" | "interactive";
}

export interface ObserveResult {
  refs: Array<{
    ref: string;
    role: string;
    name: string;
    description?: string;
    selector?: string;
  }>;
}

export interface ScreenshotArgs extends BrowserActionMeta {
  tabId: TabId;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
}

export interface EvaluateJsArgs extends BrowserActionMeta {
  tabId: TabId;
  expression: string;
  destructive?: boolean;
  awaitPromise?: boolean;
}

export type BrowserAction =
  | { kind: "upload_file"; args: UploadArgs }
  | { kind: "navigate"; args: NavigateArgs }
  | { kind: "click"; args: ClickArgs }
  | { kind: "fill_form"; args: FillFormArgs }
  | { kind: "observe"; args: ObserveArgs }
  | { kind: "screenshot"; args: ScreenshotArgs }
  | { kind: "evaluate_js"; args: EvaluateJsArgs };

export type BrowserError =
  | { code: "host_unreachable"; message: string }
  | { code: "extension_unreachable"; message: string }
  | { code: "not_attached"; tabId: TabId; message: string }
  | { code: "tab_not_found"; tabId: TabId; message: string }
  | { code: "ambiguous_tab"; candidates: TabInfo[]; message: string }
  | { code: "cross_session_tab"; tabId: TabId; ownerSessionId: SessionId; message: string }
  | { code: "element_not_found"; selector: string; message: string }
  | { code: "consent_denied"; message: string }
  | { code: "consent_timeout"; message: string }
  | { code: "rate_limit_exceeded"; tag: string; resetAt: string; message: string }
  | { code: "outside_activity_window"; nextWindowAt: string; message: string }
  | { code: "cdp_error"; cdpCode: number; cdpMessage: string; message: string }
  | { code: "detached"; tabId: TabId; reason: string; message: string };

export function browserError<C extends BrowserError["code"]>(
  code: C,
  extra: Omit<Extract<BrowserError, { code: C }>, "code">,
): Extract<BrowserError, { code: C }> {
  return { code, ...extra } as Extract<BrowserError, { code: C }>;
}
