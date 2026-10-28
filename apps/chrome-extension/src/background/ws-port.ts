/**
 * WebSocket transport to fn-browserd's `/ws/extension`, the networked
 * counterpart to {@link NativePort}. Exposes the SAME NativePortEvents surface
 * so the command router / consent / tab-group forwarding stay transport-
 * agnostic; the SW picks one transport per boot (see index.ts).
 *
 * Critical difference from a Chrome native `Port`: a raw `WebSocket` does NOT
 * auto-GC its listeners. Every dial therefore goes through a single idempotent
 * `teardown()` that removeEventListener's all four handlers, closes the
 * superseded socket, and clears the reconnect/liveness timers — called at the
 * top of every reconnect and on shutdown. A generation counter makes any frame
 * or event from a superseded socket a no-op (mirrors the daemon's
 * SwitchableSocketTransport: exactly one live socket, stale frames dropped).
 */

import {
  type BrowserIdentity,
  type HostHelloAck,
  type NativeMessage,
  newMessageId,
  PROTOCOL_VERSION,
} from "../shared/protocol.js";
import type { NativePortEvents } from "./native-port.js";

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;

/** Monotonic clock for liveness math. Unlike `Date.now()`, `performance.now()`
 *  doesn't jump on a wall-clock/NTP step, so it can't misfire the liveness
 *  timeout from a clock adjustment. It also excludes system-sleep time, so a
 *  wake from sleep does NOT instantly trip the liveness re-dial: if the daemon
 *  link survived sleep its pings resume and reset the clock; if it died, the
 *  re-dial fires after LIVENESS_TIMEOUT_MS of real post-wake silence. Available
 *  in the MV3 service-worker global scope; resets per SW respawn (harmless — the
 *  WsPort is reconstructed and re-seeds `lastInbound` on connect). */
const monotonicNowMs = (): number => performance.now();
/** ±30% jitter so a fleet of extensions doesn't reconnect in lockstep when the
 *  daemon restarts. */
const JITTER = 0.3;
/** The daemon pings every ~10s; treat silence longer than this as a wedged
 *  daemon (TCP up, app dead — `close` would never fire) and re-dial. */
const LIVENESS_TIMEOUT_MS = 25_000;
const LIVENESS_CHECK_MS = 5_000;

export interface WsPortConfig {
  /** e.g. `ws://127.0.0.1:7722/ws/extension` */
  url: string;
  /** Shared secret; appended as `?token=`. Empty for loopback no-auth. */
  token: string;
  /** This profile's identity, sent in the hello. */
  browser: BrowserIdentity;
  /** Injectable for tests; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

type Sock = Pick<
  WebSocket,
  "readyState" | "send" | "close" | "addEventListener" | "removeEventListener"
>;

export class WsPort {
  private socket: Sock | null = null;
  /** Bumped on every (re)connect and teardown; handlers bound to an old
   *  generation no-op, so a slow frame from a superseded socket can't resolve
   *  against the new connection. */
  private generation = 0;
  private backoff = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeDone = false;
  private lastInbound = 0;
  private listeners: Array<[string, EventListener]> = [];
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(
    private readonly config: WsPortConfig,
    private readonly events: NativePortEvents,
  ) {
    this.WebSocketImpl = config.WebSocketImpl ?? WebSocket;
  }

  connect(): void {
    if (this.socket) return;
    const gen = ++this.generation;
    const sep = this.config.url.includes("?") ? "&" : "?";
    const url = this.config.token
      ? `${this.config.url}${sep}token=${encodeURIComponent(this.config.token)}`
      : this.config.url;

    let socket: WebSocket;
    try {
      socket = new this.WebSocketImpl(url);
    } catch (err) {
      this.events.onError(err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    const open: EventListener = () => {
      if (gen !== this.generation) return;
      this.sendHello();
    };
    const message: EventListener = (ev) => {
      if (gen !== this.generation) return;
      this.lastInbound = monotonicNowMs();
      this.handleMessage((ev as MessageEvent).data);
    };
    const close: EventListener = () => {
      if (gen !== this.generation) return;
      this.handleDrop("closed");
    };
    const error: EventListener = () => {
      if (gen !== this.generation) return;
      this.handleDrop("error");
    };
    this.listeners = [
      ["open", open],
      ["message", message],
      ["close", close],
      ["error", error],
    ];
    for (const [type, fn] of this.listeners) socket.addEventListener(type, fn);
  }

  send(message: NativeMessage): void {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (err) {
      this.events.onError(err);
    }
  }

  get isConnected(): boolean {
    return (
      this.socket?.readyState === this.WebSocketImpl.OPEN && this.handshakeDone
    );
  }

  /**
   * Idempotent. Removes all socket listeners, closes the socket, and clears the
   * reconnect + liveness timers. Bumps the generation so any pending handler/
   * frame from the old socket is ignored. Call before re-dialing and on
   * shutdown — this is what stops a raw WebSocket from leaking handlers/timers
   * across reconnects.
   */
  teardown(): void {
    this.generation++;
    this.clearTimers();
    this.closeSocket();
    this.handshakeDone = false;
  }

  private closeSocket(): void {
    const s = this.socket;
    if (!s) return;
    for (const [type, fn] of this.listeners) s.removeEventListener(type, fn);
    this.listeners = [];
    try {
      s.close();
    } catch {
      /* already closing/closed */
    }
    this.socket = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /** Socket dropped (close/error/liveness). Tear down and re-dial. */
  private handleDrop(reason: string): void {
    if (!this.socket) return;
    this.closeSocket();
    this.clearTimers();
    this.handshakeDone = false;
    this.events.onDisconnect(reason);
    this.scheduleReconnect();
  }

  private handleMessage(raw: unknown): void {
    let message: NativeMessage;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw)) as NativeMessage;
    } catch (err) {
      this.events.onError(err);
      return;
    }
    if (message.kind === "hello_ack") {
      this.handshakeDone = true;
      this.backoff = RECONNECT_INITIAL_MS;
      this.startLiveness();
      this.events.onConnect();
      this.checkVersion(message);
      return;
    }
    if (message.kind === "ping") {
      this.send({ id: message.id, kind: "pong" });
      return;
    }
    if (message.kind === "command") {
      this.events.onCommand(message);
      return;
    }
    // hello / pong / responses / events authored by this side: ignore.
  }

  private checkVersion(ack: HostHelloAck): void {
    if (ack.protocolVersion !== PROTOCOL_VERSION) {
      this.events.onError(
        new Error(
          `Daemon protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${ack.protocolVersion}`,
        ),
      );
    }
  }

  private sendHello(): void {
    this.send({
      id: newMessageId(),
      kind: "hello",
      extensionVersion:
        typeof chrome !== "undefined" && chrome.runtime?.getManifest
          ? chrome.runtime.getManifest().version
          : "0.0.0",
      protocolVersion: PROTOCOL_VERSION,
      browser: this.config.browser,
    });
  }

  private startLiveness(): void {
    this.lastInbound = monotonicNowMs();
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = setInterval(() => {
      if (monotonicNowMs() - this.lastInbound > LIVENESS_TIMEOUT_MS) {
        // Silently-wedged daemon: no pings arriving. `close` won't fire, so
        // force a re-dial.
        this.handleDrop("liveness_timeout");
      }
    }, LIVENESS_CHECK_MS);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base = this.backoff;
    const delay = base * (1 - JITTER + Math.random() * JITTER * 2);
    this.backoff = Math.min(base * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
