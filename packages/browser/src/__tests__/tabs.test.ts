import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adoptTab, createTab } from "../cdp/tabs.js";

/**
 * Minimal in-memory chrome.tabs / chrome.tabGroups fake. Records group() calls
 * and tabGroups.update() calls so we can assert the lazy group-creation path
 * (the only logic these CDP-less ops own).
 */
interface FakeTab {
  id: number;
  url: string;
  title: string;
  windowId: number;
  groupId: number;
  active: boolean;
}

function installFakeChrome() {
  const tabs = new Map<number, FakeTab>();
  const groupCalls: Array<{ groupId?: number; tabIds: number[]; windowId?: number }> = [];
  const groupUpdates: Array<{ groupId: number; title?: string; color?: string }> = [];
  let nextTabId = 1;
  let nextGroupId = 1000;

  const chrome = {
    tabs: {
      async create(props: { url?: string; windowId?: number; active?: boolean }): Promise<FakeTab> {
        const tab: FakeTab = {
          id: nextTabId++,
          url: props.url ?? "",
          title: "",
          windowId: props.windowId ?? 1,
          groupId: -1,
          active: props.active ?? true,
        };
        tabs.set(tab.id, tab);
        return tab;
      },
      async get(id: number): Promise<FakeTab> {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`no tab ${id}`);
        return tab;
      },
      async group(opts: {
        groupId?: number;
        tabIds: number[];
        createProperties?: { windowId?: number };
      }): Promise<number> {
        const windowId = opts.createProperties?.windowId;
        groupCalls.push({ groupId: opts.groupId, tabIds: opts.tabIds, windowId });
        const groupId = opts.groupId ?? nextGroupId++;
        for (const id of opts.tabIds) {
          const tab = tabs.get(id);
          if (tab) {
            tab.groupId = groupId;
            if (windowId !== undefined) tab.windowId = windowId;
          }
        }
        return groupId;
      },
    },
    tabGroups: {
      async update(groupId: number, props: { title?: string; color?: string }): Promise<unknown> {
        groupUpdates.push({ groupId, ...props });
        return { id: groupId, ...props };
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = chrome;
  return { tabs, groupCalls, groupUpdates };
}

describe("createTab", () => {
  let fake: ReturnType<typeof installFakeChrome>;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("leaves the tab ungrouped when no group instruction is given", async () => {
    const tab = await createTab({ url: "https://example.com" });
    expect(tab.groupId).toBe(-1);
    expect(fake.groupCalls).toHaveLength(0);
    expect(fake.groupUpdates).toHaveLength(0);
  });

  it("joins an existing group by id (no createProperties, no title update)", async () => {
    const tab = await createTab({ url: "https://example.com", group: { id: 42 } });
    expect(tab.groupId).toBe(42);
    expect(fake.groupCalls).toEqual([{ groupId: 42, tabIds: [tab.id], windowId: undefined }]);
    expect(fake.groupUpdates).toHaveLength(0);
  });

  it("creates a new group pinned to the tab's window and titles/colors it", async () => {
    const tab = await createTab({
      url: "https://example.com",
      windowId: 7,
      group: { create: { name: "session-x", color: "purple" } },
    });
    expect(tab.groupId).toBeGreaterThan(0);
    expect(tab.windowId).toBe(7);
    // New-group call carries createProperties.windowId and no groupId.
    expect(fake.groupCalls).toEqual([{ groupId: undefined, tabIds: [tab.id], windowId: 7 }]);
    expect(fake.groupUpdates).toEqual([{ groupId: tab.groupId, title: "session-x", color: "purple" }]);
  });

  it("closes the created tab and rethrows if grouping fails (no orphan)", async () => {
    const removed: number[] = [];
    const chrome = (globalThis as { chrome: { tabs: Record<string, unknown> } }).chrome;
    chrome.tabs.group = async () => {
      throw new Error("group failed");
    };
    chrome.tabs.remove = async (id: number) => {
      removed.push(id);
    };
    await expect(createTab({ url: "https://example.com", group: { id: 42 } })).rejects.toThrow(
      /group failed/,
    );
    expect(removed).toHaveLength(1); // the orphaned tab was closed
  });
});

describe("adoptTab", () => {
  let fake: ReturnType<typeof installFakeChrome>;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function seedTab(windowId: number): Promise<number> {
    const tab = await createTab({ url: "https://seed.com", windowId });
    return tab.id;
  }

  it("joins an existing group by id", async () => {
    const tabId = await seedTab(3);
    fake.groupCalls.length = 0;
    const tab = await adoptTab({ tabId: tabId as never, group: { id: 88 } });
    expect(tab.groupId).toBe(88);
    expect(fake.groupCalls).toEqual([{ groupId: 88, tabIds: [tabId], windowId: undefined }]);
    expect(fake.groupUpdates).toHaveLength(0);
  });

  it("creates a new group pinned to the adopted tab's window", async () => {
    const tabId = await seedTab(5);
    fake.groupCalls.length = 0;
    const tab = await adoptTab({
      tabId: tabId as never,
      group: { create: { name: "adopted", color: "green" } },
    });
    expect(tab.groupId).toBeGreaterThan(0);
    // New group pinned to the tab's current window (5), not the active window.
    expect(fake.groupCalls).toEqual([{ groupId: undefined, tabIds: [tabId], windowId: 5 }]);
    expect(fake.groupUpdates).toEqual([{ groupId: tab.groupId, title: "adopted", color: "green" }]);
  });

  it("rolls back the user's tab when the new-group color update fails", async () => {
    const tabId = await seedTab(5); // ungrouped to start
    const ungrouped: number[][] = [];
    const chrome = (globalThis as { chrome: { tabs: Record<string, unknown>; tabGroups: Record<string, unknown> } }).chrome;
    chrome.tabs.ungroup = async (ids: number[]) => {
      ungrouped.push(ids);
    };
    chrome.tabGroups.update = async () => {
      throw new Error("bad color");
    };
    await expect(
      adoptTab({ tabId: tabId as never, group: { create: { name: "x", color: "green" } } }),
    ).rejects.toThrow(/bad color/);
    // The tab was restored to its original (ungrouped) state, not left in an
    // untracked new group.
    expect(ungrouped).toEqual([[tabId]]);
  });
});
