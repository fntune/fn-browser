/**
 * Typed wrapper around chrome.debugger.sendCommand.
 *
 * Intentional CDP-hygiene rule: this module NEVER enables Runtime / Console /
 * Debugger domains, and NEVER calls Page.evaluateOnNewDocument. Those leak
 * execution-context-ids and injected-script fingerprints that tier-1 bot
 * detectors (Cloudflare JA4+, DataDome, Kasada) probe for. The primitives we
 * build on top of `send` do not require any of them.
 */

import type { TabId } from "./types.js";
import { browserError, type BrowserError } from "./types.js";

export interface SendOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const FORBIDDEN_METHODS: ReadonlySet<string> = new Set([
  "Runtime.enable",
  "Console.enable",
  "Debugger.enable",
  "Page.evaluateOnNewDocument",
]);

export async function send<T = unknown>(
  tabId: TabId,
  method: string,
  params: Record<string, unknown> = {},
  options: SendOptions = {},
): Promise<T> {
  if (FORBIDDEN_METHODS.has(method)) {
    throw new Error(
      `CDP method ${method} is forbidden by @fntune/browser stealth hygiene. ` +
        `See packages/browser/README.md for the rationale.`,
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `CDP command timed out after ${timeoutMs}ms: ${method} on tab ${tabId}`,
        ),
      );
    }, timeoutMs);

    chrome.debugger.sendCommand(
      { tabId: tabId as unknown as number },
      method,
      params,
      (result) => {
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          const err: BrowserError = browserError("cdp_error", {
            cdpCode: 0,
            cdpMessage: lastError.message ?? "unknown",
            message: `CDP ${method} failed on tab ${tabId}: ${lastError.message}`,
          });
          reject(cdpErrorToJsError(err));
          return;
        }
        resolve(result as T);
      },
    );
  });
}

function cdpErrorToJsError(err: Extract<BrowserError, { code: "cdp_error" }>): Error {
  const e = new Error(err.message);
  (e as Error & { browserError: BrowserError }).browserError = err;
  return e;
}

/**
 * Extract the structured BrowserError from an error thrown by `send`, if any.
 */
export function getBrowserError(e: unknown): BrowserError | undefined {
  if (e && typeof e === "object" && "browserError" in e) {
    return (e as { browserError: BrowserError }).browserError;
  }
  return undefined;
}
