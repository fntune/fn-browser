import { describe, expect, it } from "vitest";

import { SocketTransport, type OutboundSocket } from "../transport.js";
import { ExtensionBridge, LEGACY_BROWSER } from "../extension-bridge.js";

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

function hello(version: string, browser?: unknown): string {
  return JSON.stringify({
    id: `h-${version}`,
    kind: "hello",
    extensionVersion: version,
    protocolVersion: 1,
    ...(browser !== undefined ? { browser } : {}),
  });
}

describe("SocketTransport", () => {
  it("dispatches frames and ignores malformed ones", () => {
    const t = new SocketTransport(fakeSocket());
    const seen: unknown[] = [];
    t.onMessage((m) => seen.push(m));
    t.receive("}{ not json");
    t.receive(JSON.stringify({ ok: 1 }));
    expect(seen).toEqual([{ ok: 1 }]);
  });

  it("closes the socket once and drops traffic after disconnect", () => {
    const sent: Frame[] = [];
    const sock = fakeSocket(sent);
    const t = new SocketTransport(sock);
    const seen: unknown[] = [];
    t.onMessage((m) => seen.push(m));

    t.disconnect();
    t.disconnect();
    expect(sock.closed).toBe(true);
    t.send({ kind: "ping" });
    t.receive(JSON.stringify({ late: true }));
    expect(sent).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("ExtensionBridge over a WebSocket transport", () => {
  it("handshakes, round-trips a command, and fast-fails on disconnect", async () => {
    const sent: Frame[] = [];
    const socket = fakeSocket(sent);
    const transport = new SocketTransport(socket);
    const bridge = new ExtensionBridge(transport);
    expect(bridge.isConnected).toBe(false);

    transport.receive(hello("9.9.9"));
    expect(bridge.isConnected).toBe(true);
    expect(bridge.peerVersion).toBe("9.9.9");
    expect(sent.some((m) => m.kind === "hello_ack")).toBe(true);

    const p = bridge.sendCommand("read_page", { tabId: 1 });
    const cmd = sent.find((m) => m.kind === "command" && m.method === "read_page");
    expect(cmd).toBeTruthy();
    transport.receive(JSON.stringify({ id: cmd!.id, kind: "response", ok: true, result: { text: "hi" } }));
    expect(await p).toEqual({ ok: true, result: { text: "hi" } });

    // In-flight command fast-fails when the link drops.
    const inflight = bridge.sendCommand("read_page", { tabId: 2 });
    bridge.markDisconnected();
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected).toBe(false);
    expect(await inflight).toMatchObject({ ok: false, error: { code: "extension_unreachable" } });

    // Sending while disconnected fast-fails immediately.
    expect(await bridge.sendCommand("read_page", {})).toMatchObject({
      ok: false,
      error: { code: "extension_unreachable" },
    });
  });

  it("reports status on handshake and on link loss only", () => {
    const transport = new SocketTransport(fakeSocket());
    const bridge = new ExtensionBridge(transport);
    const statuses: boolean[] = [];
    bridge.onStatus((connected) => statuses.push(connected));

    transport.receive(hello("1.0.0"));
    bridge.markDisconnected();
    bridge.markDisconnected(); // already down: no second event
    expect(statuses).toEqual([true, false]);
  });

  it("takes the browser identity from the hello", () => {
    const transport = new SocketTransport(fakeSocket());
    const bridge = new ExtensionBridge(transport);
    transport.receive(hello("1.0.0", { id: "a1b2c3d4", label: "  me@example.com " }));
    expect(bridge.browser).toEqual({ id: "a1b2c3d4", label: "me@example.com" });
  });

  it("labels a browser by its id when the label is blank", () => {
    const transport = new SocketTransport(fakeSocket());
    const bridge = new ExtensionBridge(transport);
    transport.receive(hello("1.0.0", { id: "a1b2c3d4", label: "" }));
    expect(bridge.browser).toEqual({ id: "a1b2c3d4", label: "a1b2c3d4" });
  });

  it.each([
    ["absent", undefined],
    ["malformed id", { id: "../../etc", label: "x" }],
    ["non-object", "a1b2c3d4"],
  ])("falls back to the legacy identity when the browser field is %s", (_case, browser) => {
    const transport = new SocketTransport(fakeSocket());
    const bridge = new ExtensionBridge(transport);
    transport.receive(hello("0.2.0", browser));
    expect(bridge.isConnected).toBe(true);
    expect(bridge.browser).toEqual(LEGACY_BROWSER);
  });
});
