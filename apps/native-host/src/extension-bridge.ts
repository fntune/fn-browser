/** Request/response correlator over MessageTransport; shared liveness + deadline poll. */

import type { MessageTransport } from "./transport.js";
import {
  type ExtensionToHostEvent,
  type ExtensionToHostError,
  type ExtensionToHostResponse,
  type HostHello,
  type HostHelloAck,
  newMessageId,
  PROTOCOL_VERSION,
} from "./protocol.js";
import { HOST_VERSION } from "./version.js";

export interface CommandResult {
  ok: true;
  result: unknown;
}

export interface CommandFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

type PendingCommand = {
  resolve: (r: CommandResult | CommandFailure) => void;
  method: string;
  timeoutMs: number;
  /** Monotonic deadline; checked by poll (not setTimeout — immune to clock suspend). */
  deadlineAtMs: number;
};

/** The Chrome profile behind a connection, as reported in the extension's hello. */
export interface BrowserIdentity {
  id: string;
  label: string;
}

/** Identity for extension builds that predate per-profile ids (one shared slot). */
export const LEGACY_BROWSER: BrowserIdentity = { id: "chrome", label: "chrome" };

const BROWSER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL_LENGTH = 200;

function parseBrowserIdentity(value: unknown): BrowserIdentity {
  if (!isRecord(value) || typeof value.id !== "string" || !BROWSER_ID.test(value.id)) {
    return LEGACY_BROWSER;
  }
  const label = typeof value.label === "string" ? value.label.trim().slice(0, MAX_LABEL_LENGTH) : "";
  return { id: value.id, label: label || value.id };
}

/** Default command timeout; long ops pass explicit timeoutMs. WS liveness fails faster. */
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
/** Grace after ping before declaring link dead. */
const PONG_GRACE_MS = 5_000;
/** Poll interval for liveness + deadlines. */
const LIVENESS_CHECK_MS = 2_000;

function monotonicNowMs(): number {
  return performance.now();
}

export class ExtensionBridge {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly eventHandlers = new Set<(event: ExtensionToHostEvent) => void>();
  private readonly statusHandlers = new Set<(connected: boolean) => void>();
  private connected = false;
  private extensionVersion: string | null = null;
  private identity: BrowserIdentity = LEGACY_BROWSER;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPongSinceMs: number | null = null;

  /**
   * @param pingIntervalMs App-level ping interval (WebSocket path); 0 for stdio shim.
   */
  constructor(
    private readonly bridge: MessageTransport,
    private readonly pingIntervalMs = 0,
    private readonly now: () => number = monotonicNowMs,
  ) {
    bridge.onMessage((message) => {
      this.handleMessage(message);
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get peerVersion(): string | null {
    return this.extensionVersion;
  }

  get browser(): BrowserIdentity {
    return this.identity;
  }

  /** Fires on handshake (true) and on link loss (false). */
  onStatus(handler: (connected: boolean) => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /** Guards against duplicate tab-reconcile handler registration per reconnect. */
  get eventHandlerCount(): number {
    return this.eventHandlers.size;
  }

  /** Fast-fail in-flight commands on link loss. */
  markDisconnected(): void {
    const wasConnected = this.connected;
    this.bridge.disconnect?.();
    this.connected = false;
    this.extensionVersion = null;
    this.awaitingPongSinceMs = null;
    this.stopPing();
    for (const pending of this.pending.values()) {
      pending.resolve({
        ok: false,
        error: { code: "extension_unreachable", message: "Extension disconnected." },
      });
    }
    this.pending.clear();
    this.updatePoll();
    if (wasConnected) this.emitStatus(false);
  }

  /** Clear timers for shutdown / test teardown. */
  dispose(): void {
    this.stopPing();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async sendCommand(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<CommandResult | CommandFailure> {
    if (!this.connected) {
      return {
        ok: false,
        error: {
          code: "extension_unreachable",
          message: "Extension is not connected. Is Chrome open with the fn-browser extension enabled?",
        },
      };
    }

    const id = newMessageId();
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

    return new Promise<CommandResult | CommandFailure>((resolve) => {
      this.pending.set(id, {
        resolve,
        method,
        timeoutMs,
        deadlineAtMs: this.now() + timeoutMs,
      });
      this.updatePoll();
      try {
        this.bridge.send({ id, kind: "command", method, params });
      } catch (err) {
        // Sync transport throw — fail fast instead of waiting for deadline.
        this.pending.delete(id);
        this.updatePoll();
        resolve({
          ok: false,
          error: {
            code: "extension_unreachable",
            message: `Failed to send ${method} to the extension: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        });
      }
    });
  }

  onEvent(handler: (event: ExtensionToHostEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    this.awaitingPongSinceMs = null; // any inbound frame proves liveness
    switch (message.kind) {
      case "hello":
        this.handleHello(message as unknown as HostHello);
        return;
      case "response":
        this.handleResponse(message as unknown as ExtensionToHostResponse | ExtensionToHostError);
        return;
      case "event":
        this.handleEvent(message as unknown as ExtensionToHostEvent);
        return;
      case "pong":
        return;
    }
  }

  private handleHello(hello: HostHello): void {
    this.connected = true;
    this.extensionVersion = hello.extensionVersion;
    this.identity = parseBrowserIdentity(hello.browser);
    const ack: HostHelloAck = {
      id: hello.id,
      kind: "hello_ack",
      hostVersion: HOST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    };
    this.bridge.send(ack);
    this.startPing();
    this.updatePoll();
    this.emitStatus(true);
  }

  private emitStatus(connected: boolean): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(connected);
      } catch (err) {
        console.error("[extension-bridge] status handler threw:", err);
      }
    }
  }

  private startPing(): void {
    if (this.pingIntervalMs <= 0) return;
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this.awaitingPongSinceMs = this.now();
        this.bridge.send({ id: newMessageId(), kind: "ping" });
      } catch {
        this.markDisconnected();
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Start/stop the poll to match whether there's anything to watch: liveness
   *  (ping enabled + connected) or at least one in-flight command to time out. */
  private updatePoll(): void {
    const needed = (this.pingIntervalMs > 0 && this.connected) || this.pending.size > 0;
    if (needed && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), LIVENESS_CHECK_MS);
      this.pollTimer.unref?.();
    } else if (!needed && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Liveness poll order: pong watchdog first, then per-command deadlines. */
  private poll(): void {
    const now = this.now();

    // 1. Pong watchdog
    if (
      this.pingIntervalMs > 0 &&
      this.connected &&
      this.awaitingPongSinceMs !== null &&
      now - this.awaitingPongSinceMs > PONG_GRACE_MS
    ) {
      this.markDisconnected();
      return;
    }

    // 2. Per-command deadlines
    for (const [id, pending] of this.pending) {
      if (now >= pending.deadlineAtMs) {
        this.pending.delete(id);
        pending.resolve({
          ok: false,
          error: {
            code: this.connected ? "cdp_timeout" : "extension_unreachable",
            message: this.connected
              ? "Extension connected but command timed out — tab or CDP may be stalled."
              : "Extension disconnected.",
          },
        });
      }
    }
    this.updatePoll();
  }

  private handleResponse(resp: ExtensionToHostResponse | ExtensionToHostError): void {
    const pending = this.pending.get(resp.id);
    if (!pending) return;
    this.pending.delete(resp.id);
    if (resp.ok) {
      pending.resolve({ ok: true, result: resp.result });
    } else {
      pending.resolve({ ok: false, error: resp.error });
    }
    this.updatePoll();
  }

  private handleEvent(event: ExtensionToHostEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("[extension-bridge] event handler threw:", err);
      }
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
