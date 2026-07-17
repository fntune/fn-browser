/**
 * Click via CDP Input.dispatchMouseEvent on a coordinate derived from the
 * target element's box model.
 *
 * Events fire with isTrusted=true (CDP Input events are always trusted),
 * indistinguishable from hardware. Behavioral hygiene (Bézier paths, dwell)
 * is applied when humanPace is set.
 *
 * Element resolution: selector OR ref (a11y handle via observe()).
 */

import { attachIfNeeded } from "./attach.js";
import { querySelectorNodeId } from "./dom.js";
import { withTabMutex } from "./mutex.js";
import { refToBackendNodeId } from "./observe.js";
import { send } from "./send.js";
import { browserError, type ClickArgs, type TabId } from "./types.js";

export interface ClickResult {
  ok: true;
  x: number;
  y: number;
}

interface BoxModel {
  model: {
    content: number[]; // [x1, y1, x2, y2, x3, y3, x4, y4] (quad)
    width: number;
    height: number;
  };
}

export async function click(args: ClickArgs): Promise<ClickResult> {
  return withTabMutex(args.tabId, async () => {
    await attachIfNeeded(args.tabId);

    const box = await resolveBox(args);
    const [x, y] = centerOf(box.model.content);

    if (args.humanPace) {
      await humanPaceMouseMove(args.tabId, x, y);
    } else {
      await send(args.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
      });
    }

    await send(args.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send(args.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });

    return { ok: true, x, y };
  });
}

async function resolveBox(args: ClickArgs): Promise<BoxModel> {
  if (args.ref) {
    const backendNodeId = refToBackendNodeId(args.ref);
    if (backendNodeId === undefined) {
      throwElementNotFound(`ref:${args.ref}`);
    }
    return send<BoxModel>(args.tabId, "DOM.getBoxModel", { backendNodeId });
  }
  if (args.selector) {
    const nodeId = await querySelectorNodeId(args.tabId, args.selector);
    if (nodeId === undefined) {
      throwElementNotFound(args.selector);
    }
    return send<BoxModel>(args.tabId, "DOM.getBoxModel", { nodeId });
  }
  throw new Error("click requires selector or ref");
}

function throwElementNotFound(selector: string): never {
  const err = browserError("element_not_found", {
    selector,
    message: `element ${selector} not found`,
  });
  const e = new Error(err.message);
  (e as Error & { browserError: typeof err }).browserError = err;
  throw e;
}

function centerOf(quad: number[]): [number, number] {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const x = xs.reduce((a, b) => a + b, 0) / 4;
  const y = ys.reduce((a, b) => a + b, 0) / 4;
  return [x, y];
}

/**
 * Approximate a human-paced mouse move: 6–10 intermediate points along a
 * slightly curved path, 8–18 ms between each, tiny pixel jitter. Good enough
 * to defeat "is this a straight-line automation pointer" heuristics without
 * overcomplicating.
 */
async function humanPaceMouseMove(tabId: TabId, x: number, y: number): Promise<void> {
  const steps = 6 + Math.floor(Math.random() * 5);
  let sx = Math.max(0, x - 40 - Math.random() * 40);
  let sy = Math.max(0, y - 40 - Math.random() * 40);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - (1 - t) * (1 - t);
    const px = sx + (x - sx) * eased + (Math.random() - 0.5) * 1.2;
    const py = sy + (y - sy) * eased + (Math.random() - 0.5) * 1.2;
    sx = px;
    sy = py;
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: px,
      y: py,
      button: "none",
      buttons: 0,
    });
    await sleep(8 + Math.random() * 10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
