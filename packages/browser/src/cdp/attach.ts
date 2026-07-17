/**
 * chrome.debugger attach/detach lifecycle with idempotency and cleanup hooks.
 *
 * - attachIfNeeded() is safe to call multiple times; only one attach is issued
 *   per tab. Concurrent callers share the in-flight Promise.
 * - detachTab() cleans up registry + registered cleanup handlers.
 * - onDetach() registers handlers that fire when chrome.debugger.onDetach
 *   dispatches for a tab (e.g., DevTools opened, user dismissed warning bar,
 *   tab closed). Used by stop-overlay and session registry.
 */

import type { TabId } from "./types.js";
import { Semaphore } from "./semaphore.js";

const CDP_PROTOCOL_VERSION = "1.3";

/**
 * Cap on simultaneous `chrome.debugger.attach` calls. 10 concurrent sessions
 * attaching ~3 tabs each would otherwise issue ~30 attaches at once; this
 * bounds the spike rate (not the total attached-tab count). The permit is a
 * leaf — it acquires no further lock — so it cannot deadlock.
 */
const DEFAULT_MAX_CONCURRENT_ATTACH = 4;
let attachSemaphore = new Semaphore(DEFAULT_MAX_CONCURRENT_ATTACH);

interface AttachEntry {
  promise: Promise<void>;
  attachedAt: number;
  /** Set by detachTab if it runs while this attach is still queued/in-flight,
   *  so the attach is skipped (or undone) instead of leaving Chrome attached
   *  while the registry considers the tab detached. */
  aborted: boolean;
}

const attached = new Map<TabId, AttachEntry>();
const detachListeners = new Map<TabId, Set<DetachHandler>>();

export type DetachReason =
  | "target_closed"
  | "canceled_by_user"
  | "replaced_with_devtools"
  | "target_closed_while_handling_message"
  | string;

export type DetachHandler = (reason: DetachReason) => void | Promise<void>;

let globalListenerInstalled = false;

function installGlobalListener(): void {
  if (globalListenerInstalled) return;
  globalListenerInstalled = true;

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    const tabId = source.tabId as unknown as TabId;
    attached.delete(tabId);
    const listeners = detachListeners.get(tabId);
    if (!listeners) return;
    detachListeners.delete(tabId);
    for (const handler of listeners) {
      try {
        void handler(reason);
      } catch {
        // Handlers must not throw upward; they are best-effort cleanup.
      }
    }
  });
}

export async function attachIfNeeded(tabId: TabId): Promise<void> {
  installGlobalListener();

  const existing = attached.get(tabId);
  if (existing) return existing.promise;

  // The semaphore is acquired *inside* this shared promise body, so concurrent
  // callers for the same tab (which await this one promise) take at most one
  // permit between them — the cap bounds distinct-tab attaches, not callers.
  const entry: AttachEntry = { promise: Promise.resolve(), attachedAt: Date.now(), aborted: false };
  entry.promise = attachWithPermit(tabId, entry);
  attached.set(tabId, entry);

  try {
    await entry.promise;
  } catch (err) {
    // Only drop our own entry — a concurrent detach+re-attach may have replaced it.
    if (attached.get(tabId) === entry) attached.delete(tabId);
    throw err;
  }
}

async function attachWithPermit(tabId: TabId, entry: AttachEntry): Promise<void> {
  const release = await attachSemaphore.acquire();
  try {
    // Detached while we waited in the queue — don't issue the attach at all.
    if (entry.aborted) return;
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach(
        { tabId: tabId as unknown as number },
        CDP_PROTOCOL_VERSION,
        () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(`chrome.debugger.attach failed: ${lastError.message}`));
            return;
          }
          resolve();
        },
      );
    });
    // Detached during the attach round-trip — undo it so Chrome isn't left
    // attached while the registry treats the tab as detached.
    if (entry.aborted) {
      chrome.debugger.detach({ tabId: tabId as unknown as number }, () => {
        void chrome.runtime.lastError;
      });
    }
  } finally {
    release();
  }
}

export async function detachTab(tabId: TabId): Promise<void> {
  const entry = attached.get(tabId);
  if (!entry) return;

  // Cancel a still-queued/in-flight attach so it doesn't attach behind our back.
  entry.aborted = true;
  attached.delete(tabId);

  await new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId: tabId as unknown as number }, () => {
      // Swallow chrome.runtime.lastError — tab may already be gone.
      void chrome.runtime.lastError;
      resolve();
    });
  });

  const listeners = detachListeners.get(tabId);
  if (listeners) {
    detachListeners.delete(tabId);
    for (const handler of listeners) {
      try {
        void handler("target_closed");
      } catch {
        // best-effort
      }
    }
  }
}

export function isAttached(tabId: TabId): boolean {
  return attached.has(tabId);
}

export function onDetach(tabId: TabId, handler: DetachHandler): () => void {
  installGlobalListener();
  let set = detachListeners.get(tabId);
  if (!set) {
    set = new Set();
    detachListeners.set(tabId, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
    // Drop the empty Set so a handler unsubscribed BEFORE the tab detaches
    // doesn't leave an orphaned empty entry. Only delete if this set is STILL
    // the current one for the tab — a stale unsub (tab detached + re-attached
    // with a fresh set) must not drop the newer set's handlers.
    if (set && set.size === 0 && detachListeners.get(tabId) === set) {
      detachListeners.delete(tabId);
    }
  };
}

/**
 * Test-only helper. Resets all module state. Do not call in production code.
 */
export function __resetAttachStateForTests(): void {
  attached.clear();
  detachListeners.clear();
  globalListenerInstalled = false;
  attachSemaphore = new Semaphore(DEFAULT_MAX_CONCURRENT_ATTACH);
}

/**
 * Test-only helper to vary the attach concurrency cap. Rebuilds the semaphore.
 */
export function __setMaxConcurrentAttachForTests(max: number): void {
  attachSemaphore = new Semaphore(max);
}

/** Test-only: number of tabs with a registered detach-listener Set. */
export function __detachListenerTabCountForTests(): number {
  return detachListeners.size;
}
