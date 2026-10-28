/**
 * Connection manager for the native-messaging port to com.fn.browser.
 *
 * - Connects on SW wake; reconnects on disconnect with exponential backoff.
 * - Forwards inbound commands from the host to a provided handler.
 * - Exposes send() for the SW to emit events and responses back to the host.
 *
 * The native host is spawned by Chrome on connectNative. When it dies or the
 * SW goes idle, the port closes. On next SW wake (or next connect attempt),
 * Chrome respawns the host.
 */

import {
  type BrowserIdentity,
  type HostToExtensionCommand,
  type HostHelloAck,
  PROTOCOL_VERSION,
  newMessageId,
  type NativeMessage,
} from "../shared/protocol.js";

const HOST_NAME = "com.fn.browser";
const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export interface NativePortEvents {
  onConnect: () => void;
  onDisconnect: (reason: string) => void;
  onCommand: (cmd: HostToExtensionCommand) => void;
  onError: (err: unknown) => void;
}

export class NativePort {
  private port: chrome.runtime.Port | null = null;
  private backoff = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeDone = false;

  constructor(
    private readonly events: NativePortEvents,
    private readonly browser: BrowserIdentity,
  ) {}

  connect(): void {
    if (this.port) return;

    try {
      this.port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      this.events.onError(err);
      this.scheduleReconnect();
      return;
    }

    this.port.onMessage.addListener((raw) => {
      this.handleMessage(raw as NativeMessage);
    });
    this.port.onDisconnect.addListener(() => {
      const lastError = chrome.runtime.lastError;
      const reason = lastError?.message ?? "disconnected";
      this.port = null;
      this.handshakeDone = false;
      this.events.onDisconnect(reason);
      this.scheduleReconnect();
    });

    // Send handshake hello.
    const hello: NativeMessage = {
      id: newMessageId(),
      kind: "hello",
      extensionVersion: chrome.runtime.getManifest().version,
      protocolVersion: PROTOCOL_VERSION,
      browser: this.browser,
    };
    this.rawSend(hello);
  }

  send(message: NativeMessage): void {
    if (!this.port) {
      // Host not yet connected; drop the message. Background will retry on
      // next command round trip.
      return;
    }
    this.rawSend(message);
  }

  get isConnected(): boolean {
    return this.port !== null && this.handshakeDone;
  }

  private rawSend(message: NativeMessage): void {
    try {
      this.port?.postMessage(message);
    } catch (err) {
      this.events.onError(err);
    }
  }

  private handleMessage(message: NativeMessage): void {
    if (message.kind === "hello_ack") {
      this.handshakeDone = true;
      this.backoff = RECONNECT_INITIAL_MS;
      this.events.onConnect();
      void this.sanityCheckVersion(message);
      return;
    }
    if (message.kind === "command") {
      this.events.onCommand(message);
      return;
    }
    // Responses/events authored by THIS side shouldn't come back — ignore.
  }

  private sanityCheckVersion(ack: HostHelloAck): void {
    if (ack.protocolVersion !== PROTOCOL_VERSION) {
      this.events.onError(
        new Error(
          `Native host protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${ack.protocolVersion}`,
        ),
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
