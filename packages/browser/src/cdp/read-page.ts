/**
 * Page content extraction: full outerHTML, or plain text.
 *
 * outerHTML via DOM.getOuterHTML on the document root; plain text via
 * Runtime.evaluate(document.body.innerText). Both respect CDP snapshots —
 * read-consistent per call.
 */

import { attachIfNeeded } from "./attach.js";
import { send } from "./send.js";
import type { BrowserActionMeta, TabId } from "./types.js";
import { evaluateJs } from "./evaluate-js.js";

export interface ReadPageArgs extends BrowserActionMeta {
  tabId: TabId;
}

export interface ReadPageResult {
  ok: true;
  url: string;
  title: string;
  html: string;
}

export interface GetPageTextResult {
  ok: true;
  url: string;
  title: string;
  text: string;
}

export async function readPage(args: ReadPageArgs): Promise<ReadPageResult> {
  await attachIfNeeded(args.tabId);

  const { root } = await send<{ root: { nodeId: number } }>(
    args.tabId,
    "DOM.getDocument",
    { depth: -1, pierce: true },
  );
  const { outerHTML } = await send<{ outerHTML: string }>(
    args.tabId,
    "DOM.getOuterHTML",
    { nodeId: root.nodeId },
  );

  const meta = await evaluateJs<{ url: string; title: string }>({
    tabId: args.tabId,
    expression: "({ url: location.href, title: document.title })",
  });

  return {
    ok: true,
    url: meta.value.url,
    title: meta.value.title,
    html: outerHTML,
  };
}

export async function getPageText(args: ReadPageArgs): Promise<GetPageTextResult> {
  const result = await evaluateJs<{ url: string; title: string; text: string }>({
    tabId: args.tabId,
    expression: `({
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText) || ''
    })`,
  });
  return {
    ok: true,
    url: result.value.url,
    title: result.value.title,
    text: result.value.text,
  };
}
