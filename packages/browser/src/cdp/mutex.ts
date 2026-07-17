/**
 * Per-tab mutex for write operations.
 *
 * Multiple write-class CDP commands on the same tab can race (e.g., two
 * setFileInputFiles calls, or a click during a navigate). Reads are concurrent
 * because CDP snapshots are read-consistent per call.
 *
 * Implementation: map<TabId, tail> where `tail` is the last queued Promise.
 * Each withTabMutex() chains onto the tail and swaps itself in.
 */

import type { TabId } from "./types.js";

const tails = new Map<TabId, Promise<unknown>>();

export async function withTabMutex<T>(
  tabId: TabId,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = tails.get(tabId) ?? Promise.resolve();
  let release: (value: T) => void;
  let fail: (reason: unknown) => void;
  const next = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  // Prevent unhandled-rejection noise when no subsequent op attaches a handler.
  // Subsequent callers only await `prev` with a try/catch, which is fine.
  next.catch(() => undefined);
  tails.set(tabId, next);

  try {
    await prev;
  } catch {
    // Prior op's failure doesn't block subsequent ops on the same tab.
  }

  try {
    const result = await fn();
    release!(result);
    return result;
  } catch (err) {
    fail!(err);
    throw err;
  } finally {
    if (tails.get(tabId) === next) {
      tails.delete(tabId);
    }
  }
}

/**
 * Test-only helper.
 */
export function __resetMutexStateForTests(): void {
  tails.clear();
}
