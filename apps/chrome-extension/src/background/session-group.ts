/**
 * Session tab-group lifecycle in the extension.
 *
 * A session's Chrome tab group is created lazily from its first tab by
 * create_tab / adopt_tab (see @fntune/browser/cdp tabs) — there is no eager
 * placeholder tab.
 *
 * __internal_end_session_group either detaches the group (leaving tabs where
 * they are) or closes all its tabs.
 *
 * We also forward chrome.tabs / chrome.tabGroups events to the host as
 * tab_group_changed / tab_removed events so the SessionRegistry can reconcile
 * after manual user drags.
 */

import type { ExtensionToHostEvent } from "../shared/protocol.js";
import { newMessageId } from "../shared/protocol.js";

export interface EndSessionGroupArgs {
  tabGroupId: number;
  onTabs: "leave" | "close";
  tabIds: number[];
}

export async function endSessionGroup(args: EndSessionGroupArgs): Promise<{ closed: number }> {
  if (args.onTabs === "close") {
    // Close all tabs the registry knows about; Chrome drops the group when
    // its last tab closes.
    if (args.tabIds.length > 0) {
      await chrome.tabs.remove(args.tabIds);
    }
    return { closed: args.tabIds.length };
  }
  // "leave": ungroup tabs so the group dissolves but tabs remain.
  if (args.tabIds.length > 0) {
    await chrome.tabs.ungroup(args.tabIds);
  }
  return { closed: 0 };
}

/**
 * Install chrome.tabs + chrome.tabGroups listeners that forward relevant
 * events to the native host via the provided send function.
 */
export function installTabGroupEventForwarder(
  sendEvent: (event: ExtensionToHostEvent) => void,
): void {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.groupId !== undefined) {
      sendEvent({
        id: newMessageId(),
        kind: "event",
        topic: "tab_group_changed",
        payload: { tabId, groupId: tab.groupId ?? -1 },
      });
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    sendEvent({
      id: newMessageId(),
      kind: "event",
      topic: "tab_removed",
      payload: { tabId },
    });
  });

  // chrome.tabGroups.onUpdated fires when tabs move between groups too
  chrome.tabGroups.onUpdated.addListener((group) => {
    sendEvent({
      id: newMessageId(),
      kind: "event",
      topic: "tab_group_changed",
      payload: {
        tabId: -1, // group-level update; the host will re-query tabs in group
        groupId: group.id,
      },
    });
  });
}
