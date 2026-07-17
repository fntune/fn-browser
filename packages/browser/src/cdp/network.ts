/**
 * Network activity capture via Network domain (safe; not on the forbidden
 * list). Accumulates request/response pairs in a per-tab ring buffer.
 */

import { attachIfNeeded, onDetach } from "./attach.js";
import { send } from "./send.js";
import type { BrowserActionMeta, TabId } from "./types.js";

export interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  status?: number;
  type?: string;
  timestamp: number;
}

const MAX_ENTRIES_PER_TAB = 500;

const buffers = new Map<TabId, NetworkEntry[]>();
const requestIndex = new Map<TabId, Map<string, NetworkEntry>>();
const enabled = new Set<TabId>();
let listenerInstalled = false;

export interface ReadNetworkArgs extends BrowserActionMeta {
  tabId: TabId;
  pattern?: string;
  methods?: string[];
  limit?: number;
}

export async function ensureNetworkCapture(tabId: TabId): Promise<void> {
  if (enabled.has(tabId)) return;
  await attachIfNeeded(tabId);
  await send(tabId, "Network.enable", {});
  enabled.add(tabId);
  // Free per-tab capture state when the tab detaches/closes. Without this, these
  // module-level maps accumulate one permanent entry per tab id for the SW's
  // lifetime (the ring buffer bounds entries-per-tab, not the number of tabs).
  // attach.ts deletes the listener entry when it fires, so this self-cleans.
  onDetach(tabId, () => {
    enabled.delete(tabId);
    buffers.delete(tabId);
    requestIndex.delete(tabId);
  });
  installEventListener();
}

export async function readNetwork(args: ReadNetworkArgs): Promise<NetworkEntry[]> {
  await ensureNetworkCapture(args.tabId);
  const all = buffers.get(args.tabId) ?? [];
  const pat = args.pattern ? new RegExp(args.pattern, "i") : undefined;
  const methods = args.methods ? new Set(args.methods.map((m) => m.toUpperCase())) : undefined;
  const filtered = all.filter((e) => {
    if (methods && !methods.has(e.method.toUpperCase())) return false;
    if (pat && !pat.test(e.url)) return false;
    return true;
  });
  return filtered.slice(-(args.limit ?? 100));
}

interface RequestWillBeSent {
  requestId: string;
  request: { url: string; method: string };
  type?: string;
  timestamp: number;
}

interface ResponseReceived {
  requestId: string;
  response: { status: number };
}

function installEventListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId as unknown as TabId | undefined;
    if (tabId === undefined || !enabled.has(tabId)) return;

    let buf = buffers.get(tabId);
    if (!buf) {
      buf = [];
      buffers.set(tabId, buf);
    }
    let idx = requestIndex.get(tabId);
    if (!idx) {
      idx = new Map();
      requestIndex.set(tabId, idx);
    }

    if (method === "Network.requestWillBeSent") {
      const p = params as RequestWillBeSent;
      const entry: NetworkEntry = {
        requestId: p.requestId,
        method: p.request.method,
        url: p.request.url,
        type: p.type,
        timestamp: p.timestamp,
      };
      buf.push(entry);
      idx.set(p.requestId, entry);
      if (buf.length > MAX_ENTRIES_PER_TAB) {
        buf.splice(0, buf.length - MAX_ENTRIES_PER_TAB);
      }
      return;
    }

    if (method === "Network.responseReceived") {
      const p = params as ResponseReceived;
      const entry = idx.get(p.requestId);
      if (entry) entry.status = p.response.status;
    }
  });
}

/** Test-only: reset all module state. Mirrors attach.ts `__resetAttachStateForTests`. */
export function __resetNetworkStateForTests(): void {
  buffers.clear();
  requestIndex.clear();
  enabled.clear();
  listenerInstalled = false;
}
