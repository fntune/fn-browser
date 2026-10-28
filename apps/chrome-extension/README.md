# @fn-browser/chrome-extension

MV3 Chrome extension that owns `chrome.debugger` for the fn-browser stack. Bridges all CDP operations to the native host (`apps/native-host`) over native messaging, which in turn exposes them as MCP tools on `http://localhost:7722/mcp/browser` for Claude.

## Build

```bash
bun run build
```

Produces `dist/` with:

- `manifest.json` (copied)
- `sidepanel.html` (copied)
- `background/index.js` (service worker)
- `content/stop-overlay.js` (injectable content script)
- `sidepanel/index.js` (side panel UI)

## Load into Chrome

1. `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. **Load unpacked** → select `apps/chrome-extension/dist`
4. Copy the assigned extension ID

The ID is stable as long as the unpacked folder path is stable (Chrome derives it from the folder's hash). Rebuilding doesn't change it.

## Permissions rationale (for future Web Store listing)

| Permission | Why |
|---|---|
| `debugger` | CDP access via `chrome.debugger.attach` + `sendCommand`. Required for `DOM.setFileInputFiles`, `Input.dispatchMouseEvent`, a11y tree, etc. |
| `sidePanel` | Side panel UI for run state and consent dialogs |
| `nativeMessaging` | Bridge to `com.fn.browser` native host (Bun daemon that hosts MCP) |
| `storage` | Per-origin memos, three-mode HITL preferences |
| `activeTab` / `tabs` | Tab context for routing CDP commands by tab ID |
| `tabGroups` | Session → tab group isolation (multi-tenant concurrency) |
| `scripting` | Inject the stop-overlay content script when a tab is under active automation |
| `host_permissions: <all_urls>` | `chrome.debugger` needs broad scope since we drive any tab the user points us at |

The extension does **not** use `webRequest` (observe-only in MV3 anyway), proxy, or any identity-related scopes.

## Stealth hygiene

- Stop overlay mounts inside a **closed Shadow DOM** with a randomized host ID. Page JS cannot read the overlay — no MutationObserver-based extension fingerprinting.
- `web_accessible_resources.use_dynamic_url: true` — resource URLs rotate per session, so `fetch('chrome-extension://<id>/...')` probing is useless.
- All injected DOM is removed on `chrome.debugger.onDetach`. No forensic artifacts remain after a run.
- Never calls `Runtime.enable`, `Console.enable`, `Debugger.enable`, `Page.evaluateOnNewDocument`. CI grep in `@fn-browser/browser` guards against regressions.
