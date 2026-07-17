/** Standalone long-lived daemon — extension dials in over WebSocket. */

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
 * Gate `/ws/extension` upgrade (CSWSH defense): pinned extension Origin + optional token.
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
  loadEnvFile();

  const transport = new SwitchableSocketTransport();
  const extension = new ExtensionBridge(transport, 10_000); // app-level ping for WS liveness

  const port = readPort();
  const hostname = process.env.FN_BROWSER_BIND ?? "127.0.0.1";
  const { app } = createDaemonApp({ extension, bind: hostname, reapIntervalMs: 5 * 60_000 });

  const extensionToken = process.env.FN_BROWSER_EXTENSION_TOKEN;
  // Pin exact extension — prefix-only would let any installed extension impersonate.
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
        if (transport.hasSocket) extension.markDisconnected();
        transport.bind(ws);
        console.error("[fn-browserd] extension connected over WebSocket");
      },
      message(ws: ServerWebSocket, message: string | Buffer) {
        transport.receive(ws, typeof message === "string" ? message : message.toString());
      },
      close(ws: ServerWebSocket) {
        // Ignore late close from a superseded socket.
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

// Guard against starting a server when imported for tests.
if (import.meta.main) {
  main();
}
