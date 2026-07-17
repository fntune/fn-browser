/**
 * Console output capture via the Log domain (not Console — that's the forbidden
 * one). Log.enable is safe: it reports browser-level log entries (JS errors,
 * network warnings, security issues, deprecations) without leaking
 * execution-context-ids to the page.
 *
 * Entries accumulate per-tab in a ring buffer; readConsole returns a recent
 * slice matching an optional pattern.
 */

import { attachIfNeeded, onDetach } from "./attach.js";
import { send } from "./send.js";
import type { BrowserActionMeta, TabId } from "./types.js";

export interface ConsoleEntry {
  level: "verbose" | "info" | "warning" | "error";
  source: string;
  text: string;
  url?: string;
  lineNumber?: number;
  timestamp: number;
}

const MAX_ENTRIES_PER_TAB = 500;

const buffers = new Map<TabId, ConsoleEntry[]>();
const enabled = new Set<TabId>();
let listenerInstalled = false;

export interface ReadConsoleArgs extends BrowserActionMeta {
  tabId: TabId;
  pattern?: string;
  levels?: Array<ConsoleEntry["level"]>;
  limit?: number;
}

export async function ensureLogCapture(tabId: TabId): Promise<void> {
  if (enabled.has(tabId)) return;
  await attachIfNeeded(tabId);
  await send(tabId, "Log.enable", {});
  enabled.add(tabId);
  // Free per-tab capture state on detach/close so these module-level maps don't
  // accumulate one permanent entry per tab id (see network.ts for the rationale).
  onDetach(tabId, () => {
    enabled.delete(tabId);
    buffers.delete(tabId);
  });
  installEventListener();
}

export async function readConsole(args: ReadConsoleArgs): Promise<ConsoleEntry[]> {
  await ensureLogCapture(args.tabId);
  const all = buffers.get(args.tabId) ?? [];
  const levels = args.levels ? new Set(args.levels) : undefined;
  const pat = args.pattern ? new RegExp(args.pattern, "i") : undefined;
  const filtered = all.filter((e) => {
    if (levels && !levels.has(e.level)) return false;
    if (pat && !pat.test(e.text)) return false;
    return true;
  });
  const limit = args.limit ?? 100;
  return filtered.slice(-limit);
}

interface LogEntryAddedEvent {
  entry: {
    source: string;
    level: string;
    text: string;
    timestamp: number;
    url?: string;
    lineNumber?: number;
  };
}

function installEventListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== "Log.entryAdded") return;
    const tabId = source.tabId as unknown as TabId | undefined;
    if (tabId === undefined) return;
    if (!enabled.has(tabId)) return;
    const { entry } = params as LogEntryAddedEvent;
    let buf = buffers.get(tabId);
    if (!buf) {
      buf = [];
      buffers.set(tabId, buf);
    }
    buf.push({
      level: normalizeLevel(entry.level),
      source: entry.source,
      text: entry.text,
      url: entry.url,
      lineNumber: entry.lineNumber,
      timestamp: entry.timestamp,
    });
    if (buf.length > MAX_ENTRIES_PER_TAB) {
      buf.splice(0, buf.length - MAX_ENTRIES_PER_TAB);
    }
  });
}

function normalizeLevel(raw: string): ConsoleEntry["level"] {
  switch (raw) {
    case "error":
    case "warning":
    case "info":
    case "verbose":
      return raw;
    default:
      return "info";
  }
}

/** Test-only: reset all module state. Mirrors attach.ts `__resetAttachStateForTests`. */
export function __resetLogStateForTests(): void {
  buffers.clear();
  enabled.clear();
  listenerInstalled = false;
}
