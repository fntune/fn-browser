# @fntune/browser

Browser automation primitives, Flow nodes, and MCP server for Chrome via `chrome.debugger`.

Architecture: a MV3 Chrome extension owns the CDP session (through `chrome.debugger`). A Bun native-messaging host exposes browser primitives as MCP tools over HTTP on `localhost:7722`. The user's default Chrome profile is used — no launch flags, no dedicated profile.

## Subpath exports

| Subpath | Purpose |
|---|---|
| `@fntune/browser` | Re-exports of commonly-used types |
| `@fntune/browser/cdp` | `BrowserController`, typed `chrome.debugger` wrappers, shared types |
| `@fntune/browser/mcp` | `createBrowserMcpServer()` factory + `McpToolPlugin` extension point |

This package has **no `@fntune/workflows` dependency**. Flow nodes and the
`run_flow` MCP tool live in `@fntune/browser-flow`, which plugs into the MCP
server via `createBrowserMcpServer({ plugins: [createRunFlowPlugin()] })` —
the only seam between the browser stack and the workflows engine.

## Apps (in `fn/apps/`)

- `chrome-extension/` — MV3 extension that owns CDP and side panel UI
- `native-host/` — Bun process Chrome spawns via native messaging; hosts the MCP HTTP server (registers `run_flow` via `src/plugins.ts`)

## Stealth hygiene

This library **never** calls the CDP domains that leak side channels detectable by tier-1 bot vendors:

- `Runtime.enable`
- `Console.enable`
- `Page.evaluateOnNewDocument`
- `Debugger.enable`

The primitives we do use (`DOM.setFileInputFiles`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`, `Accessibility.getFullAXTree`, etc.) do not require any of the above. A CI grep guards against regressions.
