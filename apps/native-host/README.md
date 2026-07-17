# @fntune/native-host

Bun native-messaging host that Chrome spawns when the fn-browser extension calls `chrome.runtime.connectNative("com.fn.browser")`. Hosts an HTTP MCP server on `127.0.0.1:7722` so Claude can reach browser primitives while the extension owns CDP.

Runs until the extension disconnects (user closes Chrome or disables the extension), then exits cleanly. Chrome respawns on next connect.

## Build

```bash
bun run build
```

Produces `bin/host` — the binary Chrome's native-messaging manifest points at.

## Install the native-messaging manifest

After loading the extension unpacked into Chrome (see `apps/chrome-extension/README.md`), copy its ID and run:

```bash
bun run install-host -- <extension_id>
```

Writes `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.fn.browser.json` with the correct binary path and `allowed_origins`.

## Smoke test checklist

1. Build both workspaces:
   ```bash
   bun run --cwd packages/browser build
   bun run --cwd apps/chrome-extension build
   bun run --cwd apps/native-host build
   ```
2. In Chrome, go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, pick `apps/chrome-extension/dist`. Copy the assigned extension ID.
3. Install the native-messaging manifest. This also generates an MCP bearer
   token in `~/.fn-browser/env` and prints the exact `claude mcp add` command
   to run (with the token):
   ```bash
   bun run --cwd apps/native-host install-host -- <extension_id>
   ```
4. Register the MCP server with the token the installer printed. The MCP
   endpoint requires the bearer token (`FN_BROWSER_AUTH_SCOPE=mcp`), so a
   token-less registration returns 401:
   ```bash
   claude mcp add --transport http --scope user fn-browser http://localhost:7722/mcp/browser \
     --header "Authorization: Bearer <token-from-installer>"
   ```
5. Open a new Chrome window. Click the fn-browser toolbar action — the side panel should say `Native host: connected`.
6. In any terminal, `curl http://localhost:7722/health` should return `{"ok":true,"extension_connected":true,...}`.
7. Open the test fixture at `apps/native-host/fixtures/upload-test.html` in a tab. Note the tab ID via `chrome.tabs.query` in the side panel's inspector.
8. From Claude Code, call `mcp__fn-browser__upload_file` with `{tabId: <id>, selector: "input[type=file]", path: "/Users/sour4bh/resume/resume.pdf"}`. The fixture page should display the uploaded filename.

## Protocol

The native host speaks the Chrome native-messaging binary protocol on stdin/stdout:

- 4-byte little-endian length prefix
- UTF-8 JSON payload
- 1 MB cap per host→Chrome message (we chunk at the application layer)

On top of that we run a typed request/response protocol ([src/protocol.ts](src/protocol.ts)) matched to the extension's mirror in `apps/chrome-extension/src/shared/protocol.ts`.

## Ports

- `127.0.0.1:7722` — MCP HTTP server (Claude ↔ host)
- stdio — native messaging (Chrome ↔ host)

Never binds to `0.0.0.0`. Localhost-only by design.
