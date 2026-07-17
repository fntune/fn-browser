/**
 * In-process event bus for the daemon's async control plane.
 *
 * Channels are strings: `operator` (consent prompts, daemon lifecycle),
 * `run:<id>`, `session:<id>`. Subscribers receive events on a single channel;
 * `subscribeAll` taps the firehose (the operator SSE stream uses it). Handlers
 * are isolated — a throwing handler never breaks emit or other subscribers.
 */

export interface BusEvent {
  topic: string;
  payload: unknown;
  at: string;
}

export type EventHandler = (channel: string, event: BusEvent) => void;

export class EventBus {
  private readonly channels = new Map<string, Set<EventHandler>>();
  private readonly firehose = new Set<EventHandler>();

  emit(channel: string, topic: string, payload: unknown, at: string): void {
    const event: BusEvent = { topic, payload, at };
    const subs = this.channels.get(channel);
    if (subs) {
      for (const handler of subs) this.safe(handler, channel, event);
    }
    for (const handler of this.firehose) this.safe(handler, channel, event);
  }

  subscribe(channel: string, handler: EventHandler): () => void {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set && set.size === 0) this.channels.delete(channel);
    };
  }

  subscribeAll(handler: EventHandler): () => void {
    this.firehose.add(handler);
    return () => {
      this.firehose.delete(handler);
    };
  }

  private safe(handler: EventHandler, channel: string, event: BusEvent): void {
    try {
      handler(channel, event);
    } catch (err) {
      console.error("[event-bus] handler threw:", err);
    }
  }
}
