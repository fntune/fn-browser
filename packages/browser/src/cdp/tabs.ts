/**
 * Tab operations use chrome.tabs / chrome.tabGroups APIs — not CDP. They
 * only run in the extension service worker context.
 */

import type { BrowserActionMeta, ChromeTabGroupColor, TabId, TabInfo } from "./types.js";

export interface ListTabsArgs extends BrowserActionMeta {
  groupId?: number;
  windowId?: number;
}

/**
 * Where a tab should land: an existing group (`id`) or a brand-new group titled
 * + colored with the session's identity (`create`). A new group is created
 * lazily from the session's first tab — there is no placeholder seed tab.
 */
export type GroupInstruction =
  | { id: number }
  | { create: { name: string; color: ChromeTabGroupColor } };

export interface CreateTabArgs extends BrowserActionMeta {
  url: string;
  windowId?: number;
  active?: boolean;
  group?: GroupInstruction;
}

export interface AdoptTabArgs extends BrowserActionMeta {
  tabId: TabId;
  group: GroupInstruction;
}

export async function listTabs(args: ListTabsArgs = {}): Promise<TabInfo[]> {
  const query: chrome.tabs.QueryInfo = {};
  if (args.groupId !== undefined) query.groupId = args.groupId;
  if (args.windowId !== undefined) query.windowId = args.windowId;
  const tabs = await chrome.tabs.query(query);
  return tabs.map(toTabInfo);
}

export async function createTab(args: CreateTabArgs): Promise<TabInfo> {
  const created = await chrome.tabs.create({
    url: args.url,
    windowId: args.windowId,
    active: args.active ?? true,
  });
  if (args.group !== undefined && created.id !== undefined) {
    try {
      await placeInGroup(created.id, created.windowId, args.group);
      // Re-fetch since tabs.group mutates groupId after returning.
      const refreshed = await chrome.tabs.get(created.id);
      return toTabInfo(refreshed);
    } catch (err) {
      // Grouping failed AFTER the tab was created — the host only attaches a
      // tab on success, so this tab would orphan (ungrouped, untracked, never
      // closed by teardown). Best-effort close it, then surface the error.
      await chrome.tabs.remove(created.id).catch(() => {});
      throw err;
    }
  }
  return toTabInfo(created);
}

export async function adoptTab(args: AdoptTabArgs): Promise<TabInfo> {
  const tabId = args.tabId as unknown as number;
  // Capture the original grouping so we can roll back a partial failure (the
  // host never attaches on error, but Chrome may have already moved the user's
  // tab into a new group before tabGroups.update failed).
  const original = await chrome.tabs.get(tabId);
  const originalGroupId = original.groupId;
  const windowId = "create" in args.group ? original.windowId : undefined;
  try {
    await placeInGroup(tabId, windowId, args.group);
  } catch (err) {
    try {
      if (typeof originalGroupId === "number" && originalGroupId > 0) {
        await chrome.tabs.group({ groupId: originalGroupId, tabIds: [tabId] });
      } else {
        await chrome.tabs.ungroup([tabId]);
      }
    } catch {
      /* best-effort rollback */
    }
    throw err;
  }
  const refreshed = await chrome.tabs.get(tabId);
  return toTabInfo(refreshed);
}

/**
 * Place a tab into an existing group (`group.id`) or a new group seeded from
 * this tab and titled/colored with the session's identity (`group.create`).
 * Chrome forbids `createProperties` when `groupId` is set, so the two modes are
 * mutually exclusive at the call.
 */
async function placeInGroup(
  tabId: number,
  windowId: number | undefined,
  group: GroupInstruction,
): Promise<void> {
  if ("id" in group) {
    await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });
    return;
  }
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    ...(windowId !== undefined ? { createProperties: { windowId } } : {}),
  });
  await chrome.tabGroups.update(groupId, {
    title: group.create.name,
    color: group.create.color,
  });
}

function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: tab.id as unknown as TabId,
    url: tab.url ?? "",
    title: tab.title ?? "",
    windowId: tab.windowId,
    groupId: tab.groupId ?? -1,
    active: tab.active,
  };
}
