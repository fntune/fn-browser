/**
 * Native host entry point (Chrome-spawned compatibility shim).
 *
 * Chrome spawns this process via native messaging when the extension calls
 * chrome.runtime.connectNative("com.fn.browser"). It builds the daemon HTTP app
 * (see daemon/app.ts) and serves it on loopback, but its lifetime is bound to
 * the native-messaging port: it exits on stdin EOF and Chrome respawns it. The
 * standalone long-lived `fn-browserd` (Phase 1+) builds the same app via the
 * shared factory but owns a persistent lifecycle.
 *
 * Lifecycle:
 *   - stdin/stdout are the native-messaging frame stream to/from Chrome.
 *   - A Hono HTTP server on 127.0.0.1:7722 serves the MCP endpoint to Claude.
 *   - Exits on extension disconnect (stdin EOF) — Chrome respawns next time.
 */

// CRITICAL: this import MUST be first. It rebinds console.log to stderr so
// @fntune/log (used across this process) never writes to stdout, which is owned
// by Chrome's native-messaging protocol.
import "./stdout-safety.js";

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExtensionBridge } from "./extension-bridge.js";
import { NativeMessagingBridge } from "./native-messaging.js";
import { createDaemonApp } from "./daemon/app.js";
import { loadEnvFile } from "./env-file.js";

// Chrome spawns this shim with a minimal environment — pick up secrets the
// installer wrote to ~/.fn-browser/env (FN_BROWSER_AUTH_TOKENS etc.) before the
// app factory reads process.env. Real env vars keep precedence.
loadEnvFile();

// Chrome native-messaging hosts run detached; stderr only surfaces in the
// extension's service-worker console. Capture uncaught exceptions to a file
// so they can be diagnosed after the fact without having to open devtools.
try {
  const home = process.env.HOME ?? homedir();
  const dir = join(home, ".fn-browser");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "host-crashes.log");
  process.on("uncaughtException", (err) => {
    appendFileSync(logPath, `[${new Date().toISOString()}][uncaught] ${err.stack ?? err.message}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    appendFileSync(
      logPath,
      `[${new Date().toISOString()}][unhandled] ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`,
    );
  });
} catch {
  /* never break host startup on logging setup */
}

const HTTP_PORT = 7722;

function main(): void {
  const native = new NativeMessagingBridge(process.stdin, process.stdout);
  const extension = new ExtensionBridge(native);

  native.onClose(() => {
    // Chrome closed or extension disconnected — exit cleanly. Chrome will
    // respawn the host next time the extension reconnects.
    process.exit(0);
  });

  try {
    const { app } = createDaemonApp({ extension });

    Bun.serve({
      hostname: "127.0.0.1",
      port: HTTP_PORT,
      fetch: app.fetch,
    });

    // Intentional: we never log to stdout (native messaging owns stdout).
    // All diagnostics go to stderr. Chrome surfaces stderr in the extension's
    // service-worker console.
    console.error(
      `[fn-browser-host] listening on http://127.0.0.1:${HTTP_PORT} (MCP at /mcp/browser)`,
    );
  } catch (err) {
    // Startup config can fail loud (e.g. malformed FN_BROWSER_AUTH_TOKENS). The
    // uncaughtException handler would only log and leave the process attached to
    // Chrome with no server listening, so Chrome won't respawn a healthy host.
    // Terminate explicitly so the native-messaging port closes.
    console.error("[fn-browser-host] fatal startup error:", err);
    process.exit(1);
  }
}

main();
