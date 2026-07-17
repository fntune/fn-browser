import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { NativeMessagingBridge } from "../native-messaging.js";

function makeBridge() {
  const input = new PassThrough();
  const output = new PassThrough();
  const bridge = new NativeMessagingBridge(input, output);
  return { input, output, bridge };
}

function framedMessage(obj: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

describe("NativeMessagingBridge", () => {
  it("parses a single framed message", async () => {
    const { input, bridge } = makeBridge();
    const received: unknown[] = [];
    bridge.onMessage((m) => received.push(m));

    input.write(framedMessage({ hello: "world" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual([{ hello: "world" }]);
  });

  it("parses multiple frames concatenated", async () => {
    const { input, bridge } = makeBridge();
    const received: unknown[] = [];
    bridge.onMessage((m) => received.push(m));

    const concatenated = Buffer.concat([
      framedMessage({ i: 1 }),
      framedMessage({ i: 2 }),
      framedMessage({ i: 3 }),
    ]);
    input.write(concatenated);
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  });

  it("parses frames split across multiple chunks", async () => {
    const { input, bridge } = makeBridge();
    const received: unknown[] = [];
    bridge.onMessage((m) => received.push(m));

    const full = framedMessage({ msg: "split across chunks" });
    input.write(full.subarray(0, 2));
    input.write(full.subarray(2, 10));
    input.write(full.subarray(10));
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual([{ msg: "split across chunks" }]);
  });

  it("emits frames in correct length-prefix format on send", async () => {
    const { output, bridge } = makeBridge();
    const chunks: Buffer[] = [];
    output.on("data", (c: Buffer) => chunks.push(c));

    bridge.send({ n: 42 });
    await new Promise((r) => setTimeout(r, 0));

    const got = Buffer.concat(chunks);
    const length = got.readUInt32LE(0);
    const payload = JSON.parse(got.subarray(4, 4 + length).toString("utf8"));
    expect(payload).toEqual({ n: 42 });
  });

  it("throws on over-cap host->Chrome payload (>1 MB)", () => {
    const { bridge } = makeBridge();
    const huge = { data: "x".repeat(1024 * 1024 + 100) };
    expect(() => bridge.send(huge)).toThrow(/1 MB cap/);
  });

  it("fires onClose handlers when input ends", async () => {
    const { input, bridge } = makeBridge();
    let closed = false;
    bridge.onClose(() => {
      closed = true;
    });

    input.end();
    await new Promise((r) => setTimeout(r, 10));

    expect(closed).toBe(true);
    expect(bridge.isClosed).toBe(true);
  });
});
