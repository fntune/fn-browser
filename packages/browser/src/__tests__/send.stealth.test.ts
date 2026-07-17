/**
 * Static assertion: the stealth-hygiene guard in send.ts rejects forbidden
 * CDP domains. This matters because a future contributor could inadvertently
 * add Runtime.enable for some convenience call and leak us to detectors.
 */

import { describe, expect, it, vi } from "vitest";

import { send } from "../cdp/send.js";
import type { TabId } from "../cdp/types.js";

const tab = (n: number) => n as unknown as TabId;

describe("send() stealth guard", () => {
  it("refuses Runtime.enable", async () => {
    await expect(send(tab(1), "Runtime.enable", {})).rejects.toThrow(
      /forbidden by @fntune\/browser stealth hygiene/,
    );
  });

  it("refuses Console.enable", async () => {
    await expect(send(tab(1), "Console.enable", {})).rejects.toThrow(
      /forbidden/,
    );
  });

  it("refuses Debugger.enable", async () => {
    await expect(send(tab(1), "Debugger.enable", {})).rejects.toThrow(
      /forbidden/,
    );
  });

  it("refuses Page.evaluateOnNewDocument", async () => {
    await expect(send(tab(1), "Page.evaluateOnNewDocument", {})).rejects.toThrow(
      /forbidden/,
    );
  });

  it("allows DOM.setFileInputFiles (with mocked chrome.*)", async () => {
    const mockChrome = {
      debugger: {
        sendCommand: vi.fn(
          (_target, _method, _params, cb: (r: unknown) => void) => {
            cb({ ok: true });
          },
        ),
      },
      runtime: { lastError: undefined },
    };
    (globalThis as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;
    const result = await send(tab(1), "DOM.setFileInputFiles", { nodeId: 1, files: [] });
    expect(result).toEqual({ ok: true });
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledTimes(1);
  });
});
