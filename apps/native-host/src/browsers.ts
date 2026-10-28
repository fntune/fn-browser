/**
 * Connected browsers: one extension connection per Chrome profile, keyed by the
 * browser id the extension reports in its hello. A reconnect from the same
 * profile (service-worker respawn) replaces that profile's link; other profiles
 * stay connected.
 */

import type { BrowserIdentity, ExtensionBridge } from "./extension-bridge.js";
import type { ExtensionToHostEvent } from "./protocol.js";

export interface BrowserInfo extends BrowserIdentity {
  extensionVersion: string | null;
  /** Where sessions started without `browser` go: the most recently focused profile. */
  default: boolean;
}

export type BrowserEventHandler = (event: ExtensionToHostEvent, browserId: string) => void;

interface Entry {
  bridge: ExtensionBridge;
  connectedAt: number;
  focusedAt: number;
  unsubscribe: () => void;
}

export class Browsers {
  private readonly entries = new Map<string, Entry>();
  private readonly handlers = new Set<BrowserEventHandler>();

  /** Register `bridge` once its hello arrives; drop it when the link goes down. */
  track(bridge: ExtensionBridge): void {
    bridge.onStatus((connected) => {
      if (connected) this.add(bridge);
      else this.remove(bridge);
    });
  }

  add(bridge: ExtensionBridge): void {
    const { id, label } = bridge.browser;
    const prev = this.entries.get(id);
    if (prev?.bridge === bridge) return;
    if (prev) {
      this.entries.delete(id);
      prev.unsubscribe();
      prev.bridge.markDisconnected();
    }
    const unsubscribe = bridge.onEvent((event) => this.handleEvent(id, event));
    this.entries.set(id, { bridge, connectedAt: Date.now(), focusedAt: 0, unsubscribe });
    console.error(`[browsers] ${label} (${id}) connected`);
  }

  remove(bridge: ExtensionBridge): void {
    const { id, label } = bridge.browser;
    const entry = this.entries.get(id);
    if (entry?.bridge !== bridge) return;
    entry.unsubscribe();
    this.entries.delete(id);
    console.error(`[browsers] ${label} (${id}) disconnected`);
  }

  get(id: string): ExtensionBridge | undefined {
    const bridge = this.entries.get(id)?.bridge;
    return bridge?.isConnected ? bridge : undefined;
  }

  ids(): string[] {
    return this.connected().map(([id]) => id);
  }

  get isConnected(): boolean {
    return this.connected().length > 0;
  }

  /** The most recently focused browser; the earliest connection when none reported focus. */
  defaultId(): string | undefined {
    let best: [string, Entry] | undefined;
    for (const [id, entry] of this.connected()) {
      if (
        !best ||
        entry.focusedAt > best[1].focusedAt ||
        (entry.focusedAt === best[1].focusedAt && entry.connectedAt < best[1].connectedAt)
      ) {
        best = [id, entry];
      }
    }
    return best?.[0];
  }

  /** Match a connected browser by id or label (case-insensitive). */
  resolve(requested: string): string | undefined {
    const wanted = requested.trim().toLowerCase();
    return this.connected().find(
      ([id, { bridge }]) => id.toLowerCase() === wanted || bridge.browser.label.toLowerCase() === wanted,
    )?.[0];
  }

  list(): BrowserInfo[] {
    const fallback = this.defaultId();
    return this.connected().map(([id, { bridge }]) => ({
      ...bridge.browser,
      extensionVersion: bridge.peerVersion,
      default: id === fallback,
    }));
  }

  private connected(): Array<[string, Entry]> {
    return [...this.entries].filter(([, entry]) => entry.bridge.isConnected);
  }

  onEvent(handler: BrowserEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private handleEvent(id: string, event: ExtensionToHostEvent): void {
    if (event.topic === "browser_focused") {
      const entry = this.entries.get(id);
      if (entry) entry.focusedAt = Date.now();
    }
    for (const handler of this.handlers) {
      try {
        handler(event, id);
      } catch (err) {
        console.error("[browsers] event handler threw:", err);
      }
    }
  }
}
