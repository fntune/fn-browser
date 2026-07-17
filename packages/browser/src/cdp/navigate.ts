/**
 * Page.navigate + wait for load event via Page domain.
 *
 * Page.enable IS safe (unlike Runtime.enable/Console.enable) — it does not
 * leak execution-context-ids. It's what chrome-devtools-mcp and Puppeteer
 * use.
 */

import { attachIfNeeded } from "./attach.js";
import { withTabMutex } from "./mutex.js";
import { send } from "./send.js";
import { browserError, type NavigateArgs } from "./types.js";

export interface NavigateResult {
  ok: true;
  url: string;
}

const WAIT_EVENTS = {
  domcontentloaded: "Page.domContentEventFired",
  load: "Page.loadEventFired",
  networkidle: "Page.loadEventFired", // fallback — true network-idle tracking belongs in task #29
} as const;

export async function navigate(args: NavigateArgs): Promise<NavigateResult> {
  return withTabMutex(args.tabId, async () => {
    await attachIfNeeded(args.tabId);
    await send(args.tabId, "Page.enable", {});

    const waitUntil = args.waitUntil ?? "domcontentloaded";
    const timeoutMs = args.timeoutMs ?? 30_000;
    const eventName = WAIT_EVENTS[waitUntil];

    const loadPromise = waitForCdpEvent(args.tabId, eventName, timeoutMs);

    try {
      await send<{ frameId: string }>(args.tabId, "Page.navigate", {
        url: args.url,
      });
    } catch (err) {
      loadPromise.cancel();
      throw err;
    }

    try {
      await loadPromise.done;
    } catch (err) {
      const e = browserError("cdp_error", {
        cdpCode: 0,
        cdpMessage: String(err),
        message: `Page.navigate to ${args.url} did not fire ${eventName} within ${timeoutMs}ms`,
      });
      const jerr = new Error(e.message);
      (jerr as Error & { browserError: typeof e }).browserError = e;
      throw jerr;
    }

    return { ok: true, url: args.url };
  });
}

interface WaitHandle {
  done: Promise<void>;
  cancel: () => void;
}

function waitForCdpEvent(
  tabId: number,
  eventName: string,
  timeoutMs: number,
): WaitHandle {
  let listener: ((source: chrome.debugger.Debuggee, method: string) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const done = new Promise<void>((resolve, reject) => {
    listener = (source, method) => {
      if (source.tabId !== tabId) return;
      if (method !== eventName) return;
      cleanup();
      resolve();
    };
    chrome.debugger.onEvent.addListener(listener);
    timer = setTimeout(() => {
      cleanup();
      if (!cancelled) reject(new Error(`timed out waiting for ${eventName}`));
    }, timeoutMs);
  });

  function cleanup(): void {
    if (listener) chrome.debugger.onEvent.removeListener(listener);
    if (timer) clearTimeout(timer);
    listener = undefined;
    timer = undefined;
  }

  return {
    done,
    cancel: () => {
      cancelled = true;
      cleanup();
    },
  };
}
