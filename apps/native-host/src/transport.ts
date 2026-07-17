/** Host↔extension MessageTransport implementations (stdio shim, switchable WebSocket). */

export interface MessageTransport {
  onMessage(handler: (message: unknown) => void): () => void;
  send(message: unknown): void;
  /** Socket generation — bumped on bind/unbind for superseded-command detection. */
  generation?(): number;
  /** Actively tear down the current link after a liveness failure. */
  disconnect?(): void;
}

/** A connected WebSocket the daemon can send on / close (Bun ServerWebSocket satisfies it). */
export interface OutboundSocket {
  send(data: string): void;
  close?(): void;
}

/** WebSocket transport rebindable across reconnects. */
export class SwitchableSocketTransport implements MessageTransport {
  private socket: OutboundSocket | null = null;
  private readonly handlers = new Set<(message: unknown) => void>();
  /** Bumped on bind/unbind so bridge can detect superseded commands. */
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

  /** Unbind only if still active — guards late close from superseded socket. */
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

  /** Drop frames from non-active sockets. */
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
