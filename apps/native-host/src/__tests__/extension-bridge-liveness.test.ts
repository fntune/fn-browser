/**
 * Liveness + command-deadline behavior of ExtensionBridge over the WebSocket
 * transport. These exercise the silence watchdog, the connected/disconnected
 * timeout distinction, and the monotonic-clock sleep/wake property — the cases
 * the prior code left untested
 * (every other suite uses pingIntervalMs=0, so the watchdog never ran).
 *
 * The monotonic clock is INJECTED (`now`) so we can drive elapsed time
 * deterministically and independently of the poll interval; fake timers drive
 * the poll/ping intervals. `advance` steps both in lockstep, in sub-poll
 * increments, so silence accumulates the way it would in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SocketTransport, type OutboundSocket } from "../transport.js";
import { ExtensionBridge } from "../extension-bridge.js";

const PING_INTERVAL_MS = 10_000;

interface Frame {
  kind: string;
  [key: string]: unknown;
}

function fakeSocket(sink: Frame[] = []): OutboundSocket & { closed: boolean } {
  return {
    closed: false,
    send: (data: string) => sink.push(JSON.parse(data) as Frame),
    close() {
      this.closed = true;
    },
  };
}

function hello(version: string): string {
  return JSON.stringify({ id: `h-${version}`, kind: "hello", extensionVersion: version, protocolVersion: 1 });
}

function pong(): string {
  return JSON.stringify({ kind: "pong", id: "p" });
}

let clock = 0;
const now = (): number => clock;

/** Advance the injected monotonic clock and the fake timers together, in
 *  sub-poll steps so the poll observes a realistic mid-window clock. */
function advance(ms: number): void {
  const STEP = 1_000;
  let remaining = ms;
  while (remaining > 0) {
    const d = Math.min(STEP, remaining);
    clock += d;
    vi.advanceTimersByTime(d);
    remaining -= d;
  }
}

describe("ExtensionBridge liveness watchdog", () => {
  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails an in-flight command as extension_unreachable when the link goes silent (watchdog beats the deadline)", async () => {
    const sock = fakeSocket();
    const transport = new SocketTransport(sock);
    const bridge = new ExtensionBridge(transport, PING_INTERVAL_MS, now);
    transport.receive(hello("1.0.0"));
    expect(bridge.isConnected).toBe(true);

    const inflight = bridge.sendCommand("read_page", { tabId: 1 }); // deadline = 20s

    // Link goes silent (SW evicted mid-command, TCP half-open): no inbound
    // frames. Advance past the 15s silence threshold but BEFORE the 20s deadline.
    advance(16_000);

    const res = await inflight;
    expect(res).toMatchObject({ ok: false, error: { code: "extension_unreachable" } });
    expect(bridge.isConnected).toBe(false);
    expect(sock.closed).toBe(true);
  });

  it("gives a delayed ping its full pong grace after an event-loop stall", () => {
    const sock = fakeSocket();
    const transport = new SocketTransport(sock);
    const bridge = new ExtensionBridge(transport, PING_INTERVAL_MS, now);
    transport.receive(hello("1.0.0"));

    // Simulate the JS event loop being blocked: monotonic time advances before
    // any overdue timer callback gets a chance to run. The delayed ping fires
    // on resume and must not be judged against the pre-stall hello timestamp.
    clock += 20_000;
    vi.advanceTimersByTime(20_000);
    expect(bridge.isConnected).toBe(true);

    transport.receive(pong());
    expect(bridge.isConnected).toBe(true);
  });

  it("does NOT disconnect a healthy idle link (pongs keep arriving every ping interval)", async () => {
    // The round-4 false-disconnect blocker: a 10s healthy inter-pong gap must
    // never trip the 15s threshold.
    const sent: Frame[] = [];
    const sock = fakeSocket(sent);
    const transport = new SocketTransport(sock);
    const bridge = new ExtensionBridge(transport, PING_INTERVAL_MS, now);
    transport.receive(hello("1.0.0"));

    for (let i = 0; i < 6; i++) {
      advance(PING_INTERVAL_MS); // ping fires
      transport.receive(pong()); // extension answers — resets the silence clock
    }

    expect(bridge.isConnected).toBe(true);
    // The daemon really did ping across the window.
    expect(sent.filter((m) => m.kind === "ping").length).toBeGreaterThanOrEqual(5);
  });

  it("times out a slow-but-alive op as cdp_timeout (connected), not extension_unreachable", async () => {
    // Preserves the policy-store consent-timeout consumer, which matches
    // cdp_timeout exactly.
    const sock = fakeSocket();
    const transport = new SocketTransport(sock);
    const bridge = new ExtensionBridge(transport, PING_INTERVAL_MS, now);
    transport.receive(hello("1.0.0"));

    const slow = bridge.sendCommand("navigate", { tabId: 1, url: "https://x" }); // deadline 20s

    advance(PING_INTERVAL_MS);
    transport.receive(pong()); // link stays alive at t=10s
    advance(11_000); // t=21s: deadline (20s) reached while the link is alive

    const res = await slow;
    expect(res).toMatchObject({ ok: false, error: { code: "cdp_timeout" } });
    expect((res as { error: { message: string } }).error.message).toMatch(/timed out/i);
    expect(bridge.isConnected).toBe(true);
  });

  it("on wake from a long sleep with a dead link, the in-flight command fails as extension_unreachable, never a spurious cdp_timeout", async () => {
    const sock = fakeSocket();
    const transport = new SocketTransport(sock);
    const bridge = new ExtensionBridge(transport, PING_INTERVAL_MS, now);
    transport.receive(hello("1.0.0"));

    const inflight = bridge.sendCommand("read_page", { tabId: 1 }); // deadline 20s

    // 5-minute sleep then wake: both clocks jump well past the silence threshold
    // AND the command deadline. The poll checks silence before deadlines, so the
    // result is the retryable code, not cdp_timeout.
    advance(300_000);

    const res = await inflight;
    expect(res).toMatchObject({ ok: false, error: { code: "extension_unreachable" } });
    expect((res as { error: { code: string } }).error.code).not.toBe("cdp_timeout");
    expect(bridge.isConnected).toBe(false);
  });

  it("stops its background poll once disconnected and idle (no leaked timers)", () => {
    const sock = fakeSocket();
    const transport = new SocketTransport(sock);
    const bridge = new ExtensionBridge(transport, PING_INTERVAL_MS, now);
    transport.receive(hello("1.0.0"));
    expect(vi.getTimerCount()).toBeGreaterThan(0); // ping + poll armed

    bridge.markDisconnected();
    // No pending, not connected ⇒ ping and poll are both cleared.
    expect(vi.getTimerCount()).toBe(0);
  });
});
