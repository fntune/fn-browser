import { describe, expect, it } from "vitest";
import type { SessionId } from "@fn-browser/browser/cdp";

import { Browsers } from "../browsers.js";
import { ExtensionBridge } from "../extension-bridge.js";
import { createMcpServer } from "../mcp-server.js";
import { SocketTransport } from "../transport.js";

interface Frame {
  id: string;
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

type Responder = (method: string, params: Record<string, unknown>) => unknown;

/** A Chrome profile's extension on a fake socket that answers every command. */
function profile(id: string, label: string, respond: Responder = () => null) {
  const commands: Frame[] = [];
  const socket = {
    closed: false,
    send(data: string) {
      const frame = JSON.parse(data) as Frame;
      if (frame.kind !== "command") return;
      commands.push(frame);
      const result = respond(frame.method!, frame.params ?? {});
      queueMicrotask(() =>
        transport.receive(JSON.stringify({ id: frame.id, kind: "response", ok: true, result })),
      );
    },
    close() {
      this.closed = true;
    },
  };
  const transport = new SocketTransport(socket);
  const bridge = new ExtensionBridge(transport);
  return {
    bridge,
    socket,
    commands,
    methods: () => commands.map((c) => c.method),
    hello() {
      transport.receive(
        JSON.stringify({
          id: `hello-${id}`,
          kind: "hello",
          extensionVersion: "0.3.0",
          protocolVersion: 1,
          browser: { id, label },
        }),
      );
    },
    focus() {
      transport.receive(
        JSON.stringify({ id: `focus-${id}`, kind: "event", topic: "browser_focused", payload: {} }),
      );
    },
  };
}

function connect(browsers: Browsers, ...profiles: ReturnType<typeof profile>[]): void {
  for (const p of profiles) {
    browsers.track(p.bridge);
    p.hello();
  }
}

/** Tab lists per profile, plus group info for create/adopt so sessions bind a group. */
function tabs(ids: number[], groupId: number): Responder {
  return (method, params) => {
    if (method === "list_tabs") return ids.map((id) => ({ id, url: `https://example.com/${id}` }));
    if (method === "create_tab") return { id: ids[0], groupId, windowId: 1 };
    if (method === "adopt_tab") return { id: params.tabId, groupId, windowId: 1 };
    if (method === "__internal_request_consent") return { choice: "allow" };
    return null;
  };
}

describe("Browsers", () => {
  it("keeps one connection per profile instead of letting profiles replace each other", () => {
    const browsers = new Browsers();
    const work = profile("aaaa1111", "me@work.com");
    const home = profile("bbbb2222", "me@home.com");
    connect(browsers, work, home);

    expect(browsers.ids()).toEqual(["aaaa1111", "bbbb2222"]);
    expect(work.socket.closed).toBe(false);
    expect(home.socket.closed).toBe(false);
  });

  it("replaces a profile's stale link when the same profile reconnects", () => {
    const browsers = new Browsers();
    const before = profile("aaaa1111", "me@work.com");
    const after = profile("aaaa1111", "me@work.com");
    connect(browsers, before, after);

    expect(before.socket.closed).toBe(true);
    expect(before.bridge.isConnected).toBe(false);
    expect(browsers.get("aaaa1111")).toBe(after.bridge);
  });

  it("drops a browser when its link goes down", () => {
    const browsers = new Browsers();
    const work = profile("aaaa1111", "me@work.com");
    connect(browsers, work);
    work.bridge.markDisconnected();
    expect(browsers.ids()).toEqual([]);
    expect(browsers.isConnected).toBe(false);
  });

  it("defaults to the most recently focused browser, else the earliest connection", () => {
    const browsers = new Browsers();
    const work = profile("aaaa1111", "me@work.com");
    const home = profile("bbbb2222", "me@home.com");
    connect(browsers, work, home);
    expect(browsers.defaultId()).toBe("aaaa1111");

    home.focus();
    expect(browsers.defaultId()).toBe("bbbb2222");
    expect(browsers.list().find((b) => b.default)?.label).toBe("me@home.com");
  });

  it("resolves a browser by id or label, case-insensitively", () => {
    const browsers = new Browsers();
    connect(browsers, profile("aaaa1111", "me@work.com"), profile("bbbb2222", "me@home.com"));
    expect(browsers.resolve("ME@HOME.COM")).toBe("bbbb2222");
    expect(browsers.resolve("aaaa1111")).toBe("aaaa1111");
    expect(browsers.resolve("me@elsewhere.com")).toBeUndefined();
  });
});

describe("routing across browsers", () => {
  function setup() {
    const browsers = new Browsers();
    const work = profile("aaaa1111", "me@work.com", tabs([11, 12], 501));
    const home = profile("bbbb2222", "me@home.com", tabs([21, 22], 502));
    connect(browsers, work, home);
    const { server, sessions } = createMcpServer({ browsers });
    return { server, sessions, work, home };
  }

  async function start(server: ReturnType<typeof setup>["server"], args: Record<string, unknown> = {}) {
    const res = await server.callTool("start", args);
    if (!res.ok) throw new Error(res.error.message);
    return res.result as { sessionId: SessionId; browser: string | null };
  }

  it("binds a session to the focused browser and sends its tabs there", async () => {
    const { server, work, home } = setup();
    home.focus();

    const { sessionId, browser } = await start(server);
    expect(browser).toBe("bbbb2222");

    const res = await server.callTool("create_tab", { url: "https://example.com" }, { sessionId });
    expect(res.ok).toBe(true);
    expect(home.methods()).toContain("create_tab");
    expect(work.methods()).not.toContain("create_tab");
  });

  it("binds a session to the browser named in start", async () => {
    const { server, work, home } = setup();
    home.focus();

    const { sessionId, browser } = await start(server, { browser: "me@work.com" });
    expect(browser).toBe("aaaa1111");

    await server.callTool("create_tab", { url: "https://example.com" }, { sessionId });
    expect(work.methods()).toContain("create_tab");
    expect(home.methods()).not.toContain("create_tab");
  });

  it("rejects an unknown browser and names the connected ones", async () => {
    const { server } = setup();
    const res = await server.callTool("start", { browser: "nope" });
    expect(res).toMatchObject({ ok: false, error: { code: "unknown_browser" } });
    expect(!res.ok && res.error.message).toContain("me@work.com (aaaa1111)");
  });

  it("lists tabs from every browser, tagged with the browser holding each", async () => {
    const { server } = setup();
    const res = await server.callTool("list_tabs", { scope: "all" });
    expect(res.ok && (res.result as Array<{ id: number; browser: string }>).map((t) => [t.id, t.browser])).toEqual([
      [11, "aaaa1111"],
      [12, "aaaa1111"],
      [21, "bbbb2222"],
      [22, "bbbb2222"],
    ]);
  });

  it("sends a sessionless command on an unowned tab to the browser holding it", async () => {
    const { server, work, home } = setup();
    const res = await server.callTool("get_page_text", { tabId: 22 });
    expect(res.ok).toBe(true);
    expect(home.methods()).toContain("get_page_text");
    expect(work.methods()).not.toContain("get_page_text");
  });

  it("moves a session with no tabs yet to the browser of the tab it adopts", async () => {
    const { server, sessions, home } = setup();
    const { sessionId, browser } = await start(server, { browser: "aaaa1111" });
    expect(browser).toBe("aaaa1111");

    const res = await server.callTool("adopt_tab", { tabId: 21 }, { sessionId });
    expect(res.ok).toBe(true);
    expect(home.methods()).toContain("adopt_tab");
    expect(sessions.get(sessionId)?.browser).toBe("bbbb2222");
  });

  it("refuses to adopt a tab from another browser into a session that already has tabs", async () => {
    const { server } = setup();
    const { sessionId } = await start(server, { browser: "aaaa1111" });
    await server.callTool("create_tab", { url: "https://example.com" }, { sessionId });

    const res = await server.callTool("adopt_tab", { tabId: 21 }, { sessionId });
    expect(res).toMatchObject({ ok: false, error: { code: "cross_browser_tab", details: { browser: "bbbb2222" } } });
  });

  it("binds a restored session lazily to the default browser", async () => {
    const { server, sessions, work } = setup();
    const sessionId = "restored-session" as SessionId;
    sessions.create({ id: sessionId, name: "restored" });

    await server.callTool("create_tab", { url: "https://example.com" }, { sessionId });
    expect(work.methods()).toContain("create_tab");
    expect(sessions.get(sessionId)?.browser).toBe("aaaa1111");
  });

  it("closes a session's tab group in the session's browser", async () => {
    const { server, work, home } = setup();
    const { sessionId } = await start(server, { browser: "me@home.com" });
    await server.callTool("create_tab", { url: "https://example.com" }, { sessionId });

    const res = await server.callTool("end", { on_tabs: "close" }, { sessionId });
    expect(res.ok).toBe(true);
    expect(home.methods()).toContain("__internal_end_session_group");
    expect(work.methods()).not.toContain("__internal_end_session_group");
  });

  it("exposes connected browsers through list_browsers", async () => {
    const { server, home } = setup();
    home.focus();
    const res = await server.callTool("list_browsers", {});
    expect(res).toMatchObject({
      ok: true,
      result: {
        browsers: [
          { id: "aaaa1111", label: "me@work.com", default: false },
          { id: "bbbb2222", label: "me@home.com", default: true },
        ],
      },
    });
  });
});
