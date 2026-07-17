/**
 * CDP-driven file input injection.
 *
 * This is the one-true-path for setting <input type="file">.files on strict-CSP
 * ATS pages. Chrome resolves the path in the browser process, builds the
 * FileList in-browser, writes it to the input's internal slot, and fires a
 * trusted `change` + `input` event.
 *
 * Because the bytes never cross the page's JS boundary, CSP directives
 * (script-src, connect-src, trusted-types) are all irrelevant. React's
 * _valueTracker doesn't wrap `files`, so frameworks see the change as normal.
 *
 * The input element may be hidden (display:none, visibility:hidden). CDP
 * doesn't check visibility — it writes directly to the DOM node.
 */

import { attachIfNeeded } from "./attach.js";
import { querySelectorNodeId } from "./dom.js";
import { withTabMutex } from "./mutex.js";
import { send } from "./send.js";
import { browserError } from "./types.js";
import type { UploadArgs } from "./types.js";

export interface SetFileInputResult {
  ok: true;
  path: string;
  selector: string;
}

export async function setFileInput(args: UploadArgs): Promise<SetFileInputResult> {
  return withTabMutex(args.tabId, async () => {
    await attachIfNeeded(args.tabId);

    const nodeId = await querySelectorNodeId(args.tabId, args.selector);
    if (nodeId === undefined) {
      const err = browserError("element_not_found", {
        selector: args.selector,
        message: `No element matches ${args.selector} on tab ${args.tabId}`,
      });
      const e = new Error(err.message);
      (e as Error & { browserError: typeof err }).browserError = err;
      throw e;
    }

    await send(args.tabId, "DOM.setFileInputFiles", {
      nodeId,
      files: [args.path],
    });

    return {
      ok: true,
      path: args.path,
      selector: args.selector,
    };
  });
}
