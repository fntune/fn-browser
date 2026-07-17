import { describe, expect, it } from "vitest";

import {
  daemonConfigSnapshot,
  detectLocalDaemon,
  resolveTransportConfig,
} from "../transport-config.js";

type Storage = Parameters<typeof resolveTransportConfig>[0];
const storage = (data: Record<string, unknown>): Storage =>
  ({ get: async () => data }) as unknown as Storage;

describe("resolveTransportConfig", () => {
  it("auto-detects when nothing is provisioned (no fnDaemonUrl key at all)", async () => {
    expect(await resolveTransportConfig(storage({}))).toEqual({ mode: "auto" });
  });

  it("forces the shim when fnDaemonUrl is set but empty (explicit clear)", async () => {
    // Key present but blank ⇒ an explicit opt-out, NOT auto-detect.
    expect(await resolveTransportConfig(storage({ fnDaemonUrl: "   " }))).toEqual({ mode: "shim" });
  });

  it("selects ws with url + token when a daemon URL is set", async () => {
    expect(
      await resolveTransportConfig(
        storage({ fnDaemonUrl: "ws://127.0.0.1:7722/ws/extension", fnExtensionToken: "tok" }),
      ),
    ).toEqual({ mode: "ws", url: "ws://127.0.0.1:7722/ws/extension", token: "tok" });
  });

  it("prefers managed storage over local (install-policy provisioning)", async () => {
    const local = storage({ fnDaemonUrl: "ws://local/ws", fnExtensionToken: "ltok" });
    const managed = storage({ fnDaemonUrl: "ws://managed/ws", fnExtensionToken: "mtok" });
    expect(await resolveTransportConfig(local, managed)).toEqual({
      mode: "ws",
      url: "ws://managed/ws",
      token: "mtok",
    });
  });

  it("respects a managed empty-string override that clears the local URL (forces shim)", async () => {
    const local = storage({ fnDaemonUrl: "ws://stale-local/ws", fnExtensionToken: "x" });
    const managed = storage({ fnDaemonUrl: "" }); // admin disables WS
    expect(await resolveTransportConfig(local, managed)).toEqual({ mode: "shim" });
  });

  it("defaults the token to empty when only a URL is set (loopback no-auth)", async () => {
    expect(await resolveTransportConfig(storage({ fnDaemonUrl: "ws://x/ws" }))).toEqual({
      mode: "ws",
      url: "ws://x/ws",
      token: "",
    });
  });

  it("falls back to auto-detect if storage throws (no config readable)", async () => {
    const broken = {
      get: async () => {
        throw new Error("storage unavailable");
      },
    } as unknown as Storage;
    expect(await resolveTransportConfig(broken)).toEqual({ mode: "auto" });
  });
});

describe("daemonConfigSnapshot", () => {
  it("reports url + hasToken for ws, and never the token value", () => {
    expect(daemonConfigSnapshot({ mode: "ws", url: "ws://h/ws", token: "secret" })).toEqual({
      mode: "ws",
      url: "ws://h/ws",
      hasToken: true,
    });
  });

  it("reports hasToken:false for ws with an empty token", () => {
    expect(daemonConfigSnapshot({ mode: "ws", url: "ws://h/ws", token: "" })).toEqual({
      mode: "ws",
      url: "ws://h/ws",
      hasToken: false,
    });
  });

  it("blanks the url for auto and shim", () => {
    expect(daemonConfigSnapshot({ mode: "auto" })).toEqual({ mode: "auto", url: "", hasToken: false });
    expect(daemonConfigSnapshot({ mode: "shim" })).toEqual({ mode: "shim", url: "", hasToken: false });
  });
});

describe("detectLocalDaemon", () => {
  const fetchReturning = (status: number): typeof fetch =>
    (async () => new Response(null, { status })) as unknown as typeof fetch;

  it("returns the WS URL when the daemon route answers 426 (upgrade required)", async () => {
    const url = await detectLocalDaemon(fetchReturning(426), "http://h/ws", "ws://h/ws");
    expect(url).toBe("ws://h/ws");
  });

  it("returns the WS URL when the daemon route answers 403 (origin/token gate)", async () => {
    const url = await detectLocalDaemon(fetchReturning(403), "http://h/ws", "ws://h/ws");
    expect(url).toBe("ws://h/ws");
  });

  it("returns null on 404 (the native-messaging shim — no WS route)", async () => {
    expect(await detectLocalDaemon(fetchReturning(404), "http://h/ws", "ws://h/ws")).toBeNull();
  });

  it("returns null on an unexpected 200 (some other service holding the port)", async () => {
    expect(await detectLocalDaemon(fetchReturning(200), "http://h/ws", "ws://h/ws")).toBeNull();
  });

  it("returns null when the probe throws (connection refused / timeout)", async () => {
    const boom: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await detectLocalDaemon(boom, "http://h/ws", "ws://h/ws")).toBeNull();
  });
});
