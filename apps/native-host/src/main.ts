/** Chrome native-messaging shim — EOF-bound lifetime, loopback HTTP on :7722. */
// MUST be first — stdout is Chrome's native-messaging protocol.
import "./stdout-safety.js";

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExtensionBridge } from "./extension-bridge.js";
import { NativeMessagingBridge } from "./native-messaging.js";
import { createDaemonApp } from "./daemon/app.js";
import { loadEnvFile } from "./env-file.js";

// Chrome's minimal env — load ~/.fn-browser/env before the app reads process.env.
loadEnvFile();

// stderr only surfaces in the SW console — persist crashes to disk for diagnosis.
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
    process.exit(0);
  });

  try {
    const { app } = createDaemonApp({ extension });

    Bun.serve({
      hostname: "127.0.0.1",
      port: HTTP_PORT,
      fetch: app.fetch,
    });

    console.error(
      `[fn-browser-host] listening on http://127.0.0.1:${HTTP_PORT} (MCP at /mcp/browser)`,
    );
  } catch (err) {
    // Fatal config — exit so Chrome respawns instead of hanging with no server.
    console.error("[fn-browser-host] fatal startup error:", err);
    process.exit(1);
  }
}

main();
