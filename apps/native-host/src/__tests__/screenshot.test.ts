/**
 * Tests for screenshot disk-persistence + MCP image content handling. Uses
 * an isolated HOME so persisted PNGs don't pollute the dev's real
 * ~/.fn-browser/screenshots/ directory.
 */

import { readFile, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../mcp-server.js";
import { ExtensionBridge, type CommandResult, type CommandFailure } from "../extension-bridge.js";
import { NativeMessagingBridge } from "../native-messaging.js";
import { saveScreenshot } from "../observability/screenshot-store.js";
import { browsersOf } from "./fixtures.js";

// HOME is redirected to a tmp dir by src/__tests__/setup.ts.

// 8×8 transparent PNG (smallest thing we can claim is a valid PNG).
const FIXTURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNgGAWjYBSMglEwCgYBAAQAAAF3N7x5AAAAAElFTkSuQmCC";

function makeBridge(handler: {
  sendCommand: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<CommandResult | CommandFailure>;
}): ExtensionBridge {
  const input = new PassThrough();
  const output = new PassThrough();
  const native = new NativeMessagingBridge(input, output);
  const bridge = new ExtensionBridge(native);
  Object.defineProperty(bridge, "isConnected", { get: () => true });
  Object.assign(bridge, handler);
  return bridge;
}

async function callScreenshot(args: Record<string, unknown>): Promise<{
  content: Array<Record<string, unknown>>;
}> {
  const bridge = makeBridge({
    async sendCommand(method, _params) {
      expect(method).toBe("screenshot");
      return {
        ok: true,
        result: { ok: true, data: FIXTURE_PNG_BASE64, width: 8, height: 8 },
      };
    },
  });
  const { app } = createMcpServer({ browsers: browsersOf(bridge) });

  // No X-Session-Id: session-ownership enforcement only fires when a
  // sessionId is present, so omitting it keeps this test isolated from
  // the session-registry plumbing — we're only exercising the screenshot
  // transform here.
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "screenshot", arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result: { content: Array<Record<string, unknown>> };
  };
  return body.result;
}

describe("screenshot tool response", () => {
  it("default: persists the PNG and returns both path metadata and inline image block", async () => {
    const out = await callScreenshot({ tabId: 42 });
    expect(out.content).toHaveLength(2);
    const [textBlock, imageBlock] = out.content as [
      { type: string; text: string },
      { type: string; data: string; mimeType: string },
    ];
    expect(textBlock.type).toBe("text");
    const payload = JSON.parse(textBlock.text) as {
      ok: boolean;
      path: string;
      fileUrl: string;
      bytes: number;
      width: number;
      height: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.width).toBe(8);
    expect(payload.height).toBe(8);
    expect(payload.bytes).toBeGreaterThan(0);
    expect(payload.path).toContain(process.env.HOME ?? "");
    expect(payload.path).toContain(".fn-browser");
    expect(payload.fileUrl.startsWith("file://")).toBe(true);

    // Bytes on disk match the base64 decode length.
    const info = await stat(payload.path);
    expect(info.size).toBe(payload.bytes);
    const file = await readFile(payload.path);
    expect(file.byteLength).toBe(Buffer.from(FIXTURE_PNG_BASE64, "base64").byteLength);

    // Critically: the serialised text does NOT contain the base64 blob —
    // that lives in the image content block alone.
    expect(textBlock.text.includes(FIXTURE_PNG_BASE64)).toBe(false);
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.mimeType).toBe("image/png");
    expect(imageBlock.data).toBe(FIXTURE_PNG_BASE64);
  });

  it("inline=false: path-only, no image block (opt-out for automation loops)", async () => {
    const out = await callScreenshot({ tabId: 42, inline: false });
    expect(out.content).toHaveLength(1);
    const textBlock = out.content[0] as { type: string; text: string };
    expect(textBlock.type).toBe("text");
    const payload = JSON.parse(textBlock.text) as {
      ok: boolean;
      path: string;
      bytes: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.bytes).toBeGreaterThan(0);
    // File still persisted on disk even when inline is suppressed.
    const file = await readFile(payload.path);
    expect(file.byteLength).toBe(Buffer.from(FIXTURE_PNG_BASE64, "base64").byteLength);
  });
});

describe("saveScreenshot filename collisions", () => {
  it("returns unique paths for many same-tab writes in the same millisecond", async () => {
    const saved = await Promise.all(
      Array.from({ length: 25 }, () =>
        saveScreenshot(FIXTURE_PNG_BASE64, { runId: "run12345abc", tabId: 7 }),
      ),
    );
    const paths = new Set(saved.map((s) => s.path));
    expect(paths.size).toBe(25); // no silent overwrites
    for (const s of saved) {
      expect(s.bytes).toBe(Buffer.from(FIXTURE_PNG_BASE64, "base64").byteLength);
    }
  });
});
