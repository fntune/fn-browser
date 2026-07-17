/**
 * fn-browserd — the standalone, long-lived daemon.
 *
 * Unlike the Chrome-spawned `main.ts` shim (lifetime bound to a native-messaging
 * port), this is a persistent service: it builds the same daemon app via the
 * shared factory and hosts a WebSocket endpoint (`/ws/extension`) that the
 * extension dials INTO. The extension reconnects across daemon restarts; the
 * ExtensionBridge above the switchable transport stays stable and fast-fails
 * in-flight commands on socket close.
 *
 * Not Chrome-spawned, so stdout is ours — no stdout-safety redirect needed.
 *
 * Bind defaults to loopback; the Tailscale phases expose the HTTP surface
 * without code change. The HTTP surface is gated by bearer auth
 * (FN_BROWSER_AUTH_TOKENS) and/or the trusted identity header. The extension WS
 * endpoint is gated by a shared secret (FN_BROWSER_EXTENSION_TOKEN, passed as
 * `?token=`) so a tailnet client can't impersonate the extension — and the
 * tsnet sidecar blocks `/ws/extension` outright, keeping that link loopback-only.
 */

import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { ExtensionBridge } from "./extension-bridge.js";
import { SwitchableSocketTransport } from "./transport.js";
import { createDaemonApp } from "./daemon/app.js";
import { isLoopbackBind } from "./daemon/bind.js";
import { loadEnvFile } from "./env-file.js";
import { resolveExtensionId } from "./extension.js";

const DEFAULT_PORT = 7722;

function readPort(): number {
  const raw = process.env.FN_BROWSER_PORT;
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

/** Constant-time token comparison (length mismatch short-circuits to false). */
export function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ExtensionUpgradeConfig {
  /** `chrome-extension://<id>` when an exact extension is pinned, else null. */
  allowedExtensionOrigin: string | null;
  /** Shared secret required as `?token=`; undefined ⇒ loopback-trust dev mode. */
  extensionToken: string | undefined;
}

/**
 * Gate the `/ws/extension` upgrade (CSWSH defense). Pure decision so it can be
 * tested without standing up Bun.serve:
 *  - pinned: only the exact `chrome-extension://<id>` Origin may connect;
 *  - unpinned dev: block any non-extension (web-page) Origin;
 *  - token mode: require a constant-time `?token=` match.
 * A no-Origin non-browser client is allowed (it isn't the CSWSH threat) but
 * still needs the token when one is configured.
 */
export function evaluateExtensionUpgrade(
  origin: string | null,
  token: string | null,
  config: ExtensionUpgradeConfig,
): { ok: true } | { ok: false; status: 403 } {
  const { allowedExtensionOrigin, extensionToken } = config;
  if (allowedExtensionOrigin) {
    if (origin !== allowedExtensionOrigin) return { ok: false, status: 403 };
  } else if (origin && !origin.startsWith("chrome-extension://")) {
    return { ok: false, status: 403 };
  }
  if (extensionToken && !tokenMatches(token, extensionToken)) {
    return { ok: false, status: 403 };
  }
  return { ok: true };
}

function main(): void {
  // launchd's wrapper sources ~/.fn-browser/env before exec, but a manually-run
  // daemon should see the same secrets. Real env vars keep precedence.
  loadEnvFile();

  const transport = new SwitchableSocketTransport();
  // 10s app-level ping/pong: a WebSocket gives no liveness signal when the peer
  // silently wedges (TCP up, SW gone), so the daemon drives it.
  const extension = new ExtensionBridge(transport, 10_000);

  const port = readPort();
  const hostname = process.env.FN_BROWSER_BIND ?? "127.0.0.1";
  // Long-lived daemon: sweep idle/abandoned sessions every 5 min so the
  // registry + their policy state don't grow for the process lifetime.
  const { app } = createDaemonApp({ extension, bind: hostname, reapIntervalMs: 5 * 60_000 });

  // Shared secret for the extension WS link. Unset ⇒ loopback trust (local dev);
  // set ⇒ the extension must present it as `?token=` on the upgrade. A
  // non-loopback bind without a token would expose unauthenticated extension
  // impersonation, so refuse to start in that configuration.
  const extensionToken = process.env.FN_BROWSER_EXTENSION_TOKEN;
  // Pin the exact extension (default id, or env override) — any installed
  // extension has a chrome-extension:// Origin, so a prefix check alone lets a
  // malicious one impersonate the real extension (the native-messaging
  // manifest's allowed_origins binding is lost on the WS path).
  const allowedExtensionOrigin = `chrome-extension://${resolveExtensionId()}`;
  if (!isLoopbackBind(hostname) && !extensionToken) {
    throw new Error(
      `fn-browserd bound to non-loopback ${hostname} without FN_BROWSER_EXTENSION_TOKEN — refusing to expose an unauthenticated extension WebSocket.`,
    );
  }

  Bun.serve({
    hostname,
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/extension") {
        // Block cross-site WebSocket hijack: a malicious page in the user's
        // Chrome can open a WS to localhost, and loopback alone doesn't stop it.
        // A real web page always sends its (non-extension) Origin; only the
        // extension's chrome-extension:// origin is allowed (a no-Origin
        // non-browser client in token mode is fine — it isn't the CSWSH threat).
        const decision = evaluateExtensionUpgrade(
          req.headers.get("Origin"),
          url.searchParams.get("token"),
          { allowedExtensionOrigin, extensionToken },
        );
        if (!decision.ok) {
          return new Response("forbidden", { status: decision.status });
        }
        return server.upgrade(req)
          ? undefined
          : new Response("expected websocket upgrade", { status: 426 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws: ServerWebSocket) {
        // A new extension supersedes any prior one: reset the bridge so stale
        // in-flight commands fast-fail, then bind (which closes the old socket).
        if (transport.hasSocket) extension.markDisconnected();
        transport.bind(ws);
        console.error("[fn-browserd] extension connected over WebSocket");
      },
      message(ws: ServerWebSocket, message: string | Buffer) {
        transport.receive(ws, typeof message === "string" ? message : message.toString());
      },
      close(ws: ServerWebSocket) {
        // Only tear down if THIS socket was the active one — a late close from a
        // superseded connection must not disconnect the fresh one.
        if (transport.unbind(ws)) {
          extension.markDisconnected();
          console.error("[fn-browserd] extension WebSocket closed");
        }
      },
    },
  });

  console.error(
    `[fn-browserd] listening on http://${hostname}:${port} (MCP at /mcp/browser, extension WS at /ws/extension${extensionToken ? ", token-gated" : ""})`,
  );
}

// Only bind the port when run as the entry point (the compiled binary), so
// importing this module for tests doesn't start a server.
if (import.meta.main) {
  main();
}
