# fn-browser: setup and live smoke test

End-to-end setup for the fn-browser Chrome extension + Bun native-messaging host. After this, you can call `mcp__fn-browser__*` tools from any Claude session.

## 1. Build

```bash
cd ~/projects/fn

# Build all three workspaces (packages/browser, apps/chrome-extension, apps/native-host)
bun run --cwd packages/browser build
bun run --cwd apps/chrome-extension build
bun run --cwd apps/native-host build
```

Produces:
- `packages/browser/dist/` — library artifacts (imported by extension + host)
- `apps/chrome-extension/dist/` — unpacked extension (loaded into Chrome)
- `apps/native-host/bin/host` — Bun-compiled native-messaging binary

## 2. Load the extension into Chrome

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** → pick `~/projects/fn/apps/chrome-extension/dist`.
4. Copy the extension ID Chrome assigned (looks like `abcdefghijklmnopqrstuvwxyzabcdef`).

The extension ID is stable as long as you don't move the `dist/` folder. Rebuilding in place keeps the same ID.

## 3. Install the native-messaging host manifest

```bash
bun run --cwd apps/native-host install-host -- <extension_id_from_step_2>
```

This writes:

```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.fn.browser.json
```

Containing the binary path + allowed origin. Chrome reads this on the next extension-to-host connect.

It also generates an MCP bearer token in `~/.fn-browser/env` and prints the exact `claude mcp add` command (with the token) to run in the next step.

## 4. Register the MCP server with Claude Code

The MCP endpoint requires the bearer token the installer generated (`FN_BROWSER_AUTH_SCOPE=mcp` gates `/mcp/*` so no other local process can drive your browser), so registration must send it — a token-less registration returns 401:

```bash
claude mcp add --transport http --scope user fn-browser http://localhost:7722/mcp/browser \
  --header "Authorization: Bearer <token-the-installer-printed>"
```

Use `--scope user` to register globally for your user (any project). Drop it for `local` if you only want it in the current project.

Verify:

```bash
claude mcp list
```

should show `fn-browser` with the full tool surface.

## 5. Verify the pipeline

1. Open a Chrome window. Click the `fn` toolbar icon — the side panel opens and says `Native host: connected`.
2. In any terminal:

   ```bash
   curl -s http://localhost:7722/health | jq
   # { "ok": true, "extension_connected": true, "extension_version": "0.1.0", "host_version": "0.1.0", "active_sessions": 0 }
   ```

3. Open the test fixture:

   ```bash
   open ~/projects/fn/apps/native-host/fixtures/upload-test.html
   ```

4. Grab the tab id (from the side-panel's inspector or via a quick `chrome.tabs.query` in the background SW's console).

5. From Claude Code, call:

   ```
   mcp__fn-browser__upload_file({
     tabId: <from step 4>,
     selector: "input[type=file]",
     path: "/Users/sour4bh/resume/resume.pdf"
   })
   ```

   The fixture page should show the filename + `isTrusted=true`. That's the end-to-end proof.

## 6. (Optional) Use sessions for multi-tenant isolation

If you want multiple Claude sessions or workflows driving the same Chrome in parallel with isolated tab groups:

```
# 1. Claim a session
mcp__fn-browser__start({ name: "my-session", color: "blue" })
# → { sessionId: "uuid-…", tabGroupId: 123, windowId: 1 }

# 2. Every subsequent session-aware MCP call — pass the returned `sessionId`.
#    Programmatic HTTP clients may instead send the same value as X-Session-Id.
#
#    mcp__fn-browser__create_tab({ sessionId: "uuid-…", url: "https://example.com" })
#
#    mcp__fn-browser__end({ sessionId: "uuid-…", on_tabs: "leave" })
```

A blue tab group titled "my-session" appears in your Chrome tab strip. Tabs created via `create_tab` land in this group; cross-session calls against other sessions' tabs are rejected with `cross_session_tab`.

## Troubleshooting

**`host_unreachable`** — extension isn't connected to the native host. Open Chrome + `chrome://extensions` + make sure the extension is enabled. The background SW console (click "Inspect views: service worker") shows connect errors.

**`extension_unreachable`** — the host is running but the extension hasn't called `connectNative`. This happens right after Chrome starts before the SW wakes. Click the extension icon once to wake the SW.

**Warning bar after every call** — expected. `chrome.debugger` API shows "Your browser is being debugged" per design. Dismissing it detaches the debugger. The side panel notices and offers one-click re-attach.

**`consent_denied`** — a tool call with `destructive: true` was rejected. Day-1 consent-queue behavior auto-allows after 5s; task #26 replaces this with a real modal in the side panel.

**DevTools attaches to the target tab** — Chrome enforces one debugger client per tab. Opening DevTools on an automated tab detaches `chrome.debugger`. Side panel detects and offers re-attach after DevTools closes.

## Running tests

```bash
bun run --cwd packages/browser test
bun run --cwd apps/native-host test
bun run --cwd packages/browser check:stealth
```

53+ tests across the two packages. The stealth check grep-verifies no `Runtime.enable` / `Console.enable` / `Debugger.enable` / `evaluateOnNewDocument` calls leak into the source — detector-invisible by construction.
