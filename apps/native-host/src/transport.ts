/**
 * Message transports for the host↔extension link.
 *
 * `ExtensionBridge` speaks a framed JSON protocol (hello / command / response /
 * event) over any `MessageTransport`. Two implementations exist:
 *   - `NativeMessagingBridge` (stdio frames) — the Chrome-spawned shim.
 *   - `SwitchableSocketTransport` (a WebSocket) — the long-lived daemon, into
 *     which the extension dials. The socket can be (re)bound across reconnects
 *     while the ExtensionBridge above it stays stable.
 */

export interface MessageTransport {
  onMessage(handler: (message: unknown) => void): () => void;
  send(message: unknown): void;
  /** Monotonically-increasing socket generation, bumped on every bind/unbind.
   *  Optional: only the switchable WS transport flips sockets; the stdio shim
   *  has a single fixed pipe and omits it. Lets the bridge fail a command whose
   *  socket was superseded (see ExtensionBridge.poll). */
  generation?(): number;
  /** Actively tear down the current link after a liveness failure. */
  disconnect?(): void;
}

/** A connected WebSocket the daemon can send on / close (Bun ServerWebSocket satisfies it). */
export interface OutboundSocket {
  send(data: string): void;
  close?(): void;
}

/**
 * A MessageTransport whose underlying socket can be bound/unbound across
 * reconnects. The daemon's WS handler routes inbound frames via `receive()` and
 * binds/unbinds the socket on open/close. Outbound sends drop silently when no
 * socket is bound (the ExtensionBridge reports `isConnected: false` in that
 * window, so callers fast-fail rather than hang).
 */
export class SwitchableSocketTransport implements MessageTransport {
  private socket: OutboundSocket | null = null;
  private readonly handlers = new Set<(message: unknown) => void>();
  /** Bumped on every bind and every clearing unbind, so the bridge can detect a
   *  command whose socket was superseded. Mirrors the extension's WsPort
   *  generation counter. */
  private gen = 0;

  generation(): number {
    return this.gen;
  }

  /** Make `socket` the active one. A superseded socket is closed so it can't
   * keep feeding frames. */
  bind(socket: OutboundSocket): void {
    const prev = this.socket;
    this.socket = socket;
    this.gen++;
    if (prev && prev !== socket) {
      try {
        prev.close?.();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Unbind. With a socket argument, only unbinds if it's still the active one
   * (guards against a late close from a superseded connection). Returns whether
   * the active socket was actually cleared. */
  unbind(socket?: OutboundSocket): boolean {
    if (!socket || this.socket === socket) {
      const had = this.socket !== null;
      this.socket = null;
      if (had) this.gen++;
      return had;
    }
    return false;
  }

  get hasSocket(): boolean {
    return this.socket !== null;
  }

  disconnect(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.gen++;
    try {
      socket.close?.();
    } catch {
      /* best-effort */
    }
  }

  send(message: unknown): void {
    this.socket?.send(JSON.stringify(message));
  }

  /** Feed an inbound WS frame from `socket`. Frames from a non-active (stale or
   * superseded) socket are dropped so they can't resolve commands. Malformed
   * frames are logged and dropped. */
  receive(socket: OutboundSocket, raw: string): void {
    if (socket !== this.socket) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      console.error("[ws-transport] malformed frame:", err, raw.slice(0, 200));
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch (err) {
        console.error("[ws-transport] message handler threw:", err);
      }
    }
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
