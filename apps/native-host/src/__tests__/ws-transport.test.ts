import { describe, expect, it } from "vitest";

import { SwitchableSocketTransport, type OutboundSocket } from "../transport.js";
import { ExtensionBridge } from "../extension-bridge.js";

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

describe("SwitchableSocketTransport", () => {
  it("drops outbound sends when no socket is bound", () => {
    const t = new SwitchableSocketTransport();
    expect(t.hasSocket).toBe(false);
    expect(() => t.send({ x: 1 })).not.toThrow();
  });

  it("dispatches frames from the active socket and ignores malformed ones", () => {
    const t = new SwitchableSocketTransport();
    const seen: unknown[] = [];
    t.onMessage((m) => seen.push(m));
    const sock = fakeSocket();
    t.bind(sock);
    t.receive(sock, "}{ not json");
    t.receive(sock, JSON.stringify({ ok: 1 }));
    expect(seen).toEqual([{ ok: 1 }]);
  });

  it("ignores frames from a non-active (stale) socket", () => {
    const t = new SwitchableSocketTransport();
    const seen: unknown[] = [];
    t.onMessage((m) => seen.push(m));
    const active = fakeSocket();
    const stale = fakeSocket();
    t.bind(active);
    t.receive(stale, JSON.stringify({ from: "stale" }));
    expect(seen).toEqual([]);
    t.receive(active, JSON.stringify({ from: "active" }));
    expect(seen).toEqual([{ from: "active" }]);
  });

  it("closes the superseded socket on rebind and reports unbind accuracy", () => {
    const t = new SwitchableSocketTransport();
    const a = fakeSocket();
    const b = fakeSocket();
    t.bind(a);
    t.bind(b); // supersede a
    expect(a.closed).toBe(true);
    expect(t.unbind(a)).toBe(false); // a is no longer active
    expect(t.hasSocket).toBe(true);
    expect(t.unbind(b)).toBe(true);
    expect(t.hasSocket).toBe(false);
  });

  it("bumps generation on every bind and clearing unbind only", () => {
    const t = new SwitchableSocketTransport();
    expect(t.generation()).toBe(0);
    const a = fakeSocket();
    t.bind(a);
    expect(t.generation()).toBe(1);
    const b = fakeSocket();
    t.bind(b); // supersede
    expect(t.generation()).toBe(2);
    expect(t.unbind(a)).toBe(false); // a not active — no bump
    expect(t.generation()).toBe(2);
    expect(t.unbind(b)).toBe(true); // active cleared — bump
    expect(t.generation()).toBe(3);
    expect(t.unbind()).toBe(false); // nothing bound — no bump
    expect(t.generation()).toBe(3);
  });
});

describe("ExtensionBridge over a switchable WS transport", () => {
  it("handshakes, round-trips a command, and fast-fails on disconnect", async () => {
    const sent: Frame[] = [];
    const transport = new SwitchableSocketTransport();
    const bridge = new ExtensionBridge(transport);
    expect(bridge.isConnected).toBe(false);

    const socket = fakeSocket(sent);
    transport.bind(socket);
    transport.receive(socket, hello("9.9.9"));
    expect(bridge.isConnected).toBe(true);
    expect(bridge.peerVersion).toBe("9.9.9");
    expect(sent.some((m) => m.kind === "hello_ack")).toBe(true);

    const p = bridge.sendCommand("read_page", { tabId: 1 });
    const cmd = sent.find((m) => m.kind === "command" && m.method === "read_page");
    expect(cmd).toBeTruthy();
    transport.receive(socket, JSON.stringify({ id: cmd!.id, kind: "response", ok: true, result: { text: "hi" } }));
    expect(await p).toEqual({ ok: true, result: { text: "hi" } });

    // In-flight command fast-fails when the socket closes.
    const inflight = bridge.sendCommand("read_page", { tabId: 2 });
    transport.unbind(socket);
    bridge.markDisconnected();
    expect(bridge.isConnected).toBe(false);
    expect(await inflight).toMatchObject({ ok: false, error: { code: "extension_unreachable" } });

    // Sending while disconnected fast-fails immediately.
    expect(await bridge.sendCommand("read_page", {})).toMatchObject({
      ok: false,
      error: { code: "extension_unreachable" },
    });
  });

  it("reconnects after a drop with a fresh socket", () => {
    const transport = new SwitchableSocketTransport();
    const bridge = new ExtensionBridge(transport);

    const s1 = fakeSocket();
    transport.bind(s1);
    transport.receive(s1, hello("1.0.0"));
    expect(bridge.isConnected).toBe(true);

    transport.unbind(s1);
    bridge.markDisconnected();
    expect(bridge.isConnected).toBe(false);

    const sent2: Frame[] = [];
    const s2 = fakeSocket(sent2);
    transport.bind(s2);
    transport.receive(s2, hello("1.0.1"));
    expect(bridge.isConnected).toBe(true);
    expect(bridge.peerVersion).toBe("1.0.1");
    expect(sent2.some((m) => m.kind === "hello_ack")).toBe(true);
  });
});
