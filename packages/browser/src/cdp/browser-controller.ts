/**
 * BrowserController: high-level facade over the CDP primitives.
 *
 * Intended to be instantiated inside the chrome-extension's background service
 * worker, which has `chrome.debugger` access. The native-host (Bun) imports
 * types from this package but never instantiates BrowserController directly
 * — it routes commands over native messaging to the extension.
 */

import { setFileInput, type SetFileInputResult } from "./set-file-input.js";
import type { TabId, UploadArgs } from "./types.js";
import { detachTab, isAttached, onDetach, type DetachHandler } from "./attach.js";

export interface BrowserControllerOptions {
  /**
   * Called when chrome.debugger.onDetach fires for any tab this controller is
   * driving. Useful for session registry cleanup, stop-overlay teardown.
   */
  onTabDetached?: (tabId: TabId, reason: string) => void;
}

export class BrowserController {
  private readonly perTabDetachUnsubs = new Map<TabId, () => void>();

  constructor(private readonly options: BrowserControllerOptions = {}) {}

  async uploadFile(args: UploadArgs): Promise<SetFileInputResult> {
    this.registerDetachHandler(args.tabId);
    return setFileInput(args);
  }

  isAttached(tabId: TabId): boolean {
    return isAttached(tabId);
  }

  async detach(tabId: TabId): Promise<void> {
    this.perTabDetachUnsubs.get(tabId)?.();
    this.perTabDetachUnsubs.delete(tabId);
    await detachTab(tabId);
  }

  private registerDetachHandler(tabId: TabId): void {
    if (this.perTabDetachUnsubs.has(tabId)) return;
    const handler: DetachHandler = (reason) => {
      this.perTabDetachUnsubs.delete(tabId);
      this.options.onTabDetached?.(tabId, String(reason));
    };
    const unsub = onDetach(tabId, handler);
    this.perTabDetachUnsubs.set(tabId, unsub);
  }
}
