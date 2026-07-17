/**
 * DOM-domain CDP helpers used by multiple primitives.
 *
 * querySelectorNodeId resolves a CSS selector down to a CDP nodeId by calling
 * DOM.getDocument (piercing shadow roots) + DOM.querySelector. Returns undefined
 * when the element doesn't exist so callers can surface element_not_found.
 */

import { send } from "./send.js";
import type { TabId } from "./types.js";

interface GetDocumentResult {
  root: { nodeId: number };
}

interface QuerySelectorResult {
  nodeId: number; // 0 if not found
}

export async function querySelectorNodeId(
  tabId: TabId,
  selector: string,
): Promise<number | undefined> {
  const { root } = await send<GetDocumentResult>(tabId, "DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  const { nodeId } = await send<QuerySelectorResult>(tabId, "DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  return nodeId === 0 ? undefined : nodeId;
}

interface DescribeNodeResult {
  node: {
    nodeName: string;
    attributes?: string[];
  };
}

export async function describeNode(
  tabId: TabId,
  nodeId: number,
): Promise<DescribeNodeResult["node"]> {
  const { node } = await send<DescribeNodeResult>(tabId, "DOM.describeNode", {
    nodeId,
  });
  return node;
}

export async function focusNode(tabId: TabId, nodeId: number): Promise<void> {
  await send(tabId, "DOM.focus", { nodeId });
}
