# fn-browser

Browser automation MCP for Claude: Claude drives your Chrome through a local
MV3 extension + Bun native-messaging host. 24 MCP tools (navigate, click,
screenshot, fill_form, upload_file, sessions, rate limits, …) with
human-in-the-loop consent prompts for anything destructive.

## Layout

| Path | What it is |
|---|---|
| `packages/browser` | CDP wrappers (stealth-guarded), MCP server factory, sessions, HITL policy |
| `packages/log` | Structured logger (`@fntune/log`) |
| `packages/utils` | Shared helpers — `host-classification` for SSRF origin policy |
| `apps/chrome-extension` | MV3 extension: background SW owns `chrome.debugger`, React side panel |
| `apps/native-host` | Bun binary Chrome spawns via native messaging; Hono HTTP MCP on `127.0.0.1:7722` |
| `scripts/release/bundle-browser.sh` | Builds the distributable zip (extension + binaries + installer + SETUP.md) |

## Quick start (build from source)

```bash
bun install
bun run build          # utils -> log -> browser -> extension -> host
bun run test
./scripts/release/bundle-browser.sh   # optional: produce release/fn-browser-<v>-darwin-<arch>.zip
```

Then follow the generated `SETUP.md` inside the bundle — or, from source:
load `apps/chrome-extension/dist` unpacked in `chrome://extensions`, then run
`bash apps/native-host/install/install.sh` and paste the `claude mcp add`
command it prints.

## Install from a Release

Grab the zip + `SHA256SUMS` from the latest GitHub Release (built by CI from
the tagged source — the release notes link the exact run), verify with
`shasum -c SHA256SUMS --ignore-missing`, unzip somewhere permanent, and follow
`SETUP.md` inside.

## Security model

- **MCP-scoped bearer auth**: `127.0.0.1:7722/mcp/*` requires the token the
  installer generates in `~/.fn-browser/env` (chmod 600), so no other local
  process can drive your browser. Side-panel routes stay loopback-trusted.
- **HITL consent**: destructive tool calls always prompt in the side panel
  unless you explicitly allowlist an origin ("Always allow on <host>").
- **Stealth CDP hygiene**: never calls `Runtime.enable`, `Console.enable`,
  `Debugger.enable`, or `Page.evaluateOnNewDocument`
  (`packages/browser/scripts/check-stealth.sh` enforces this in CI via the
  browser test suite).
- **Observability**: run logs in `~/.fn-browser/runs/`, screenshots in
  `~/.fn-browser/screenshots/`, crash log in `~/.fn-browser/host-crashes.log`.

## Releasing

1. Bump `version` in `apps/chrome-extension/package.json` (source of truth).
2. Tag: `git tag v<version> && git push origin v<version>`.
3. CI builds the bundle on a macOS arm64 runner and attaches zip + checksums
   to the Release.
