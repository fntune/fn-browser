/** Host↔extension MessageTransport implementations (stdio shim, per-connection WebSocket). */

export interface MessageTransport {
  onMessage(handler: (message: unknown) => void): () => void;
  send(message: unknown): void;
  /** Actively tear down the link after a liveness failure or a superseding connection. */
  disconnect?(): void;
}

/** A connected WebSocket the daemon can send on / close (Bun ServerWebSocket satisfies it). */
export interface OutboundSocket {
  send(data: string): void;
  close?(): void;
}

/** One extension WebSocket; the daemon creates one per connection. */
export class SocketTransport implements MessageTransport {
  private readonly handlers = new Set<(message: unknown) => void>();
  private open = true;

  constructor(private readonly socket: OutboundSocket) {}

  send(message: unknown): void {
    if (this.open) this.socket.send(JSON.stringify(message));
  }

  disconnect(): void {
    if (!this.open) return;
    this.open = false;
    try {
      this.socket.close?.();
    } catch {
      /* best-effort */
    }
  }

  /** Dispatch one inbound frame; frames after disconnect are dropped. */
  receive(raw: string): void {
    if (!this.open) return;
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
