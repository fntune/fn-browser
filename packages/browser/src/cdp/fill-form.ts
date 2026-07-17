/**
 * fill_form: focus each target input, dispatch trusted keypress events via
 * Input.insertText (which fires isTrusted=true input/change events), move on.
 *
 * Human-pace hygiene: 80–250 ms between keypresses, with occasional 400-800 ms
 * "thinking" pauses between fields. Applied when humanPace is true.
 */

import { attachIfNeeded } from "./attach.js";
import { focusNode, querySelectorNodeId } from "./dom.js";
import { withTabMutex } from "./mutex.js";
import { refToBackendNodeId } from "./observe.js";
import { send } from "./send.js";
import { browserError, type FillFormArgs, type TabId } from "./types.js";

export interface FillFormResult {
  ok: true;
  fieldCount: number;
}

export async function fillForm(args: FillFormArgs): Promise<FillFormResult> {
  return withTabMutex(args.tabId, async () => {
    await attachIfNeeded(args.tabId);

    for (const field of args.fields) {
      const nodeId = await resolveNodeId(args.tabId, field);
      await focusNode(args.tabId, nodeId);

      const values = Array.isArray(field.value) ? field.value : [field.value];
      for (const value of values) {
        if (args.humanPace) {
          await humanTypeText(args.tabId, value);
        } else {
          await send(args.tabId, "Input.insertText", { text: value });
        }
      }

      if (args.humanPace) {
        await sleep(400 + Math.random() * 400);
      }
    }

    return { ok: true, fieldCount: args.fields.length };
  });
}

async function resolveNodeId(
  tabId: TabId,
  field: FillFormArgs["fields"][number],
): Promise<number> {
  if (field.ref) {
    const backendNodeId = refToBackendNodeId(field.ref);
    if (backendNodeId === undefined) throwNotFound(field.ref);
    // Convert backendNodeId -> nodeId via DOM.pushNodesByBackendIdsToFrontend.
    const { nodeIds } = await send<{ nodeIds: number[] }>(
      tabId,
      "DOM.pushNodesByBackendIdsToFrontend",
      { backendNodeIds: [backendNodeId] },
    );
    if (!nodeIds[0]) throwNotFound(field.ref);
    return nodeIds[0]!;
  }
  if (field.selector) {
    const nodeId = await querySelectorNodeId(tabId, field.selector);
    if (nodeId === undefined) throwNotFound(field.selector);
    return nodeId!;
  }
  throw new Error("fill_form field requires selector or ref");
}

function throwNotFound(selector: string): never {
  const err = browserError("element_not_found", {
    selector,
    message: `element ${selector} not found`,
  });
  const e = new Error(err.message);
  (e as Error & { browserError: typeof err }).browserError = err;
  throw e;
}

async function humanTypeText(tabId: TabId, text: string): Promise<void> {
  for (const ch of text) {
    await send(tabId, "Input.insertText", { text: ch });
    // Keypress dwell: 80–250ms, with rare longer pauses (simulate thought).
    const dwell = 80 + Math.random() * 170;
    const pause = Math.random() < 0.05 ? 300 + Math.random() * 400 : 0;
    await sleep(dwell + pause);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
