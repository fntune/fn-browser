import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetAttachStateForTests } from "../cdp/attach.js";
import { __resetLogStateForTests, ensureLogCapture } from "../cdp/log-entries.js";
import { __resetNetworkStateForTests, ensureNetworkCapture } from "../cdp/network.js";
import type { TabId } from "../cdp/types.js";

const t = (n: number) => n as unknown as TabId;

type DetachListener = (source: { tabId?: number }, reason: string) => void;

interface FakeChromeState {
  sent: Array<{ tabId?: number; method: string }>;
  detachListeners: DetachListener[];
}

function installFakeChrome(): FakeChromeState {
  const state: FakeChromeState = { sent: [], detachListeners: [] };
  const runtime: { lastError?: { message: string } } = {};
  const chrome = {
    debugger: {
      attach(_t: { tabId: number }, _v: string, cb: () => void): void {
        runtime.lastError = undefined;
        cb();
      },
      sendCommand(
        target: { tabId: number },
        method: string,
        _params: unknown,
        cb: (r: unknown) => void,
      ): void {
        state.sent.push({ tabId: target.tabId, method });
        runtime.lastError = undefined;
        cb({});
      },
      detach(_t: unknown, cb: () => void): void {
        cb();
      },
      onDetach: {
        addListener(fn: DetachListener): void {
          state.detachListeners.push(fn);
        },
      },
      onEvent: { addListener(): void {} },
    },
    runtime,
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chrome;
  return state;
}

function fireDetach(state: FakeChromeState, tabId: number): void {
  for (const fn of state.detachListeners) fn({ tabId }, "target_closed");
}

describe("per-tab CDP capture cleanup on detach", () => {
  beforeEach(() => {
    __resetAttachStateForTests();
    __resetNetworkStateForTests();
    __resetLogStateForTests();
  });
  afterEach(() => {
    __resetAttachStateForTests();
    __resetNetworkStateForTests();
    __resetLogStateForTests();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("frees network capture state on detach (re-enabling re-issues Network.enable)", async () => {
    const state = installFakeChrome();
    const enables = () => state.sent.filter((s) => s.method === "Network.enable").length;

    await ensureNetworkCapture(t(7));
    expect(enables()).toBe(1);
    // Idempotent while still enabled.
    await ensureNetworkCapture(t(7));
    expect(enables()).toBe(1);

    // Tab closes -> onDetach fires -> per-tab state must be freed, not leaked.
    fireDetach(state, 7);

    // Re-enabling the same tab id re-issues Network.enable, proving `enabled`
    // (and its sibling buffers/requestIndex maps) were cleared on detach.
    await ensureNetworkCapture(t(7));
    expect(enables()).toBe(2);
  });

  it("frees log capture state on detach (re-enabling re-issues Log.enable)", async () => {
    const state = installFakeChrome();
    const enables = () => state.sent.filter((s) => s.method === "Log.enable").length;

    await ensureLogCapture(t(9));
    expect(enables()).toBe(1);
    await ensureLogCapture(t(9));
    expect(enables()).toBe(1);

    fireDetach(state, 9);

    await ensureLogCapture(t(9));
    expect(enables()).toBe(2);
  });
});
