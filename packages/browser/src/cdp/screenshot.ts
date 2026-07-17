/**
 * Page.captureScreenshot. Returns base64-encoded PNG bytes.
 *
 * Callers pass the raw base64 back through native messaging; host can decode
 * + persist under ~/.fn-browser/runs/<run_id>/. Keep the base64 under 700 KB
 * per message to stay under the 1 MB native-messaging cap (PNG data is
 * well under that for viewport-sized captures).
 */

import { attachIfNeeded } from "./attach.js";
import { send } from "./send.js";
import type { ScreenshotArgs } from "./types.js";

export interface ScreenshotResult {
  ok: true;
  data: string; // base64-encoded PNG
  width: number;
  height: number;
}

export async function screenshot(args: ScreenshotArgs): Promise<ScreenshotResult> {
  await attachIfNeeded(args.tabId);
  await send(args.tabId, "Page.enable", {});

  interface ScreenshotParams {
    format: "png" | "jpeg";
    captureBeyondViewport?: boolean;
    clip?: { x: number; y: number; width: number; height: number; scale: number };
  }

  const params: ScreenshotParams = { format: "png" };
  if (args.clip) {
    params.clip = { ...args.clip, scale: 1 };
  } else if (args.fullPage) {
    params.captureBeyondViewport = true;
  }

  const result = await send<{ data: string }>(
    args.tabId,
    "Page.captureScreenshot",
    params as unknown as Record<string, unknown>,
  );

  // Chrome doesn't report back width/height — we don't decode PNG just to
  // pull those out. Callers can decode if they need dimensions.
  return {
    ok: true,
    data: result.data,
    width: 0,
    height: 0,
  };
}
