# @fntune/browser

Browser automation primitives and MCP server for Chrome via `chrome.debugger`.

Architecture: a MV3 Chrome extension owns the CDP session (through `chrome.debugger`). A Bun native-messaging host exposes browser primitives as MCP tools over HTTP on `localhost:7722`. It runs in the user's normal Chrome profile(s) — no launch flags, no dedicated profile.

## Subpath exports

| Subpath | Purpose |
|---|---|
| `@fntune/browser` | Re-exports of commonly-used types |
| `@fntune/browser/cdp` | `BrowserController`, typed `chrome.debugger` wrappers, shared types |
| `@fntune/browser/mcp` | `createBrowserMcpServer()` factory + `McpToolPlugin` extension point |

This package has **no `@fntune/workflows` dependency**. Durable flow execution
(including a `run_flow` MCP tool) is out of scope for this distribution; the
MCP server accepts optional plugins via `createBrowserMcpServer({ plugins })`
if you wire one in yourself.

## Apps

- `apps/chrome-extension/` — MV3 extension that owns CDP and side panel UI
- `apps/native-host/` — Bun process Chrome spawns via native messaging; hosts the MCP HTTP server

## Stealth hygiene

This library **never** calls the CDP domains that leak side channels detectable by tier-1 bot vendors:

- `Runtime.enable`
- `Console.enable`
- `Page.evaluateOnNewDocument`
- `Debugger.enable`

The primitives used (`DOM.setFileInputFiles`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`, `Accessibility.getFullAXTree`, etc.) do not require any of the above. A CI grep guards against regressions.
