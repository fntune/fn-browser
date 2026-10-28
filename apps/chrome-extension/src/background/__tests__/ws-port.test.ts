import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NativePortEvents } from "../native-port.js";
import { WsPort } from "../ws-port.js";

/** Minimal WebSocket double: records sent frames + listeners, lets tests fire
 * lifecycle events. Mirrors the slice of the WebSocket API WsPort touches. */
class MockWebSocket {
  static OPEN = 1;
  static last: MockWebSocket | null = null;
  static count = 0;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(ev?: unknown) => void>>();

  constructor(public url: string) {
    MockWebSocket.last = this;
    MockWebSocket.count++;
  }
  addEventListener(type: string, fn: (ev?: unknown) => void): void {
    let s = this.listeners.get(type);
    if (!s) {
      s = new Set();
      this.listeners.set(type, s);
    }
    s.add(fn);
  }
  removeEventListener(type: string, fn: (ev?: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  totalListeners(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
  fire(type: string, ev?: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  doOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.fire("open");
  }
  recv(obj: unknown): void {
    this.fire("message", { data: JSON.stringify(obj) });
  }
  sentKinds(): string[] {
    return this.sent.map((s) => JSON.parse(s).kind as string);
  }
}

function makeEvents() {
  const state = { connects: 0, disconnects: [] as string[], commands: [] as unknown[], errors: [] as unknown[] };
  const events: NativePortEvents = {
    onConnect: () => {
      state.connects++;
    },
    onDisconnect: (r) => state.disconnects.push(r),
    onCommand: (c) => state.commands.push(c),
    onError: (e) => state.errors.push(e),
  };
  return { events, state };
}

function newPort(events: NativePortEvents): WsPort {
  return new WsPort(
    {
      url: "ws://d/ws",
      token: "tok",
      browser: { id: "a1b2c3d4", label: "me@example.com" },
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    },
    events,
  );
}

const ACK = { id: "h", kind: "hello_ack", hostVersion: "0.2.0", protocolVersion: 1 };

describe("WsPort", () => {
  beforeEach(() => {
    MockWebSocket.count = 0;
    MockWebSocket.last = null;
  });

  it("handshakes: sends hello on open, connects on hello_ack", () => {
    const { events, state } = makeEvents();
    const p = newPort(events);
    p.connect();
    const ws = MockWebSocket.last!;
    ws.doOpen();
    expect(ws.sentKinds()).toContain("hello");
    expect(JSON.parse(ws.sent[0]!).browser).toEqual({ id: "a1b2c3d4", label: "me@example.com" });
    expect(p.isConnected).toBe(false); // not until the ack
    ws.recv(ACK);
    expect(p.isConnected).toBe(true);
    expect(state.connects).toBe(1);
  });

  it("answers ping with a matching-id pong", () => {
    const { events } = makeEvents();
    const p = newPort(events);
    p.connect();
    const ws = MockWebSocket.last!;
    ws.doOpen();
    ws.recv(ACK);
    ws.recv({ id: "ping-1", kind: "ping" });
    const pong = ws.sent.map((s) => JSON.parse(s)).find((m) => m.kind === "pong");
    expect(pong).toEqual({ id: "ping-1", kind: "pong" });
  });

  it("routes commands to onCommand", () => {
    const { events, state } = makeEvents();
    const p = newPort(events);
    p.connect();
    const ws = MockWebSocket.last!;
    ws.doOpen();
    ws.recv(ACK);
    ws.recv({ id: "c1", kind: "command", method: "navigate", params: {} });
    expect(state.commands).toHaveLength(1);
  });

  it("teardown() removes every socket listener, closes the socket, and is idempotent", () => {
    const { events } = makeEvents();
    const p = newPort(events);
    p.connect();
    const ws = MockWebSocket.last!;
    expect(ws.totalListeners()).toBe(4); // open/message/close/error
    p.teardown();
    expect(ws.totalListeners()).toBe(0); // no leaked handlers
    expect(ws.readyState).toBe(3); // closed
    expect(() => p.teardown()).not.toThrow();
  });

  it("ignores frames from a superseded socket after teardown", () => {
    const { events, state } = makeEvents();
    const p = newPort(events);
    p.connect();
    const ws1 = MockWebSocket.last!;
    ws1.doOpen();
    ws1.recv(ACK);
    p.teardown();
    ws1.recv({ id: "c1", kind: "command", method: "navigate", params: {} });
    expect(state.commands).toHaveLength(0);
  });

  it("re-dials with backoff after the socket closes", () => {
    vi.useFakeTimers();
    try {
      const { events, state } = makeEvents();
      const p = newPort(events);
      p.connect();
      const ws1 = MockWebSocket.last!;
      ws1.doOpen();
      ws1.recv(ACK);
      expect(MockWebSocket.count).toBe(1);
      ws1.fire("close");
      expect(state.disconnects).toContain("closed");
      vi.advanceTimersByTime(1000); // > the jittered initial backoff (≤ ~650ms)
      expect(MockWebSocket.count).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-dials on a silently-wedged daemon (no inbound past the liveness timeout)", () => {
    vi.useFakeTimers();
    try {
      const { events, state } = makeEvents();
      const p = newPort(events);
      p.connect();
      const ws1 = MockWebSocket.last!;
      ws1.doOpen();
      ws1.recv(ACK);
      vi.advanceTimersByTime(30_000); // no pings arrive → liveness trips
      expect(state.disconnects).toContain("liveness_timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
