import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachIfNeeded,
  detachTab,
  isAttached,
  onDetach,
  __detachListenerTabCountForTests,
  __resetAttachStateForTests,
  __setMaxConcurrentAttachForTests,
} from "../cdp/attach.js";
import type { TabId } from "../cdp/types.js";

const t = (n: number) => n as unknown as TabId;

interface FakeChromeOptions {
  attachDelayMs?: number;
  failTabs?: Set<number>;
}

interface FakeChromeState {
  inFlight: number;
  peakInFlight: number;
  attachCalls: number[];
}

function installFakeChrome(opts: FakeChromeOptions = {}): FakeChromeState {
  const state: FakeChromeState = { inFlight: 0, peakInFlight: 0, attachCalls: [] };
  const runtime: { lastError?: { message: string } } = {};
  const chrome = {
    debugger: {
      attach(target: { tabId: number }, _version: string, cb: () => void): void {
        state.attachCalls.push(target.tabId);
        state.inFlight++;
        state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
        setTimeout(() => {
          state.inFlight--;
          // lastError is read synchronously inside cb(); set then clear.
          if (opts.failTabs?.has(target.tabId)) {
            runtime.lastError = { message: `boom ${target.tabId}` };
          } else {
            runtime.lastError = undefined;
          }
          cb();
          runtime.lastError = undefined;
        }, opts.attachDelayMs ?? 5);
      },
      detach(_t: unknown, cb: () => void): void {
        cb();
      },
      onDetach: { addListener(): void {} },
    },
    runtime,
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chrome;
  return state;
}

describe("attachIfNeeded concurrency cap", () => {
  beforeEach(() => {
    __resetAttachStateForTests();
  });
  afterEach(() => {
    __resetAttachStateForTests();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("caps simultaneous chrome.debugger.attach at the configured max", async () => {
    __setMaxConcurrentAttachForTests(2);
    const state = installFakeChrome({ attachDelayMs: 10 });
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => attachIfNeeded(t(n))));
    expect(state.peakInFlight).toBe(2);
    expect(state.attachCalls).toHaveLength(6);
  });

  it("dedupes same-tab callers — one attach, one permit", async () => {
    __setMaxConcurrentAttachForTests(1);
    const state = installFakeChrome({ attachDelayMs: 5 });
    await Promise.all([attachIfNeeded(t(7)), attachIfNeeded(t(7)), attachIfNeeded(t(7))]);
    expect(state.attachCalls).toEqual([7]);
    expect(isAttached(t(7))).toBe(true);
  });

  it("a queued attach detached while waiting never reaches chrome.debugger.attach", async () => {
    __setMaxConcurrentAttachForTests(1);
    const state = installFakeChrome({ attachDelayMs: 20 });
    // tab 1 holds the only permit (in-flight attach).
    const p1 = attachIfNeeded(t(1));
    // tab 2 queues behind it — no permit yet.
    const p2 = attachIfNeeded(t(2));
    // Detach tab 2 while it is still queued.
    await detachTab(t(2));
    await Promise.all([p1, p2]);
    // tab 2's queued attach was aborted → Chrome was never attached for it.
    expect(state.attachCalls).toEqual([1]);
    expect(isAttached(t(2))).toBe(false);
    expect(isAttached(t(1))).toBe(true);
  });

  it("releases the permit and clears state when attach fails", async () => {
    __setMaxConcurrentAttachForTests(1);
    installFakeChrome({ attachDelayMs: 5, failTabs: new Set([3]) });
    await expect(attachIfNeeded(t(3))).rejects.toThrow(/boom 3/);
    expect(isAttached(t(3))).toBe(false);
    // If the permit had leaked, this attach (max=1) would hang forever.
    await attachIfNeeded(t(4));
    expect(isAttached(t(4))).toBe(true);
  });

  it("removes the detach-listener entry when the last handler unsubscribes before detach", () => {
    installFakeChrome();
    const unsub = onDetach(t(5), () => {});
    expect(__detachListenerTabCountForTests()).toBe(1);
    unsub();
    // The now-empty Set must not be left orphaned in the map.
    expect(__detachListenerTabCountForTests()).toBe(0);
  });

  it("a stale detach-unsub does not drop a newer listener set for the same tab", async () => {
    installFakeChrome();
    await attachIfNeeded(t(5));
    const unsub1 = onDetach(t(5), () => {});
    expect(__detachListenerTabCountForTests()).toBe(1);
    // Tab detaches → its set is removed and handlers fire.
    await detachTab(t(5));
    expect(__detachListenerTabCountForTests()).toBe(0);
    // Same tab id re-registers with a FRESH set.
    const unsub2 = onDetach(t(5), () => {});
    expect(__detachListenerTabCountForTests()).toBe(1);
    // The stale unsub must NOT drop the newer set.
    unsub1();
    expect(__detachListenerTabCountForTests()).toBe(1);
    // The current unsub cleans up normally.
    unsub2();
    expect(__detachListenerTabCountForTests()).toBe(0);
  });
});
