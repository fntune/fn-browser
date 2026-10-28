#!/usr/bin/env bash
# Assemble the fn-browser distribution bundle: the unpacked Chrome extension,
# the compiled native-host binaries, installers, and a SETUP.md one-pager.
#
# Usage: scripts/release/bundle-browser.sh [--skip-build]
#
# Output: release/fn-browser-<version>-darwin-<arch>.zip (version from the
# extension manifest, arch from the machine that built the binaries).
#
# The zip is safe to hand to coworkers: extension sourcemaps are stripped
# (they embed full workspace source), and nothing else in the bundle contains
# repo source beyond what the compiled artifacts inherently carry.

set -euo pipefail

# The native-host binaries are compiled for the builder's platform and the zip
# is labeled darwin-<arch>. Building on Linux would package Linux executables
# under a darwin name that can't run on the recipient Mac — refuse rather than
# ship a mislabeled artifact. (Cross-compiling per target is a --target change.)
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this bundle is macOS-only; run it on a Mac (found $(uname -s))." >&2
  exit 1
fi

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
EXT_DIR="$REPO_ROOT/apps/chrome-extension"
HOST_DIR="$REPO_ROOT/apps/native-host"
OUT_DIR="$REPO_ROOT/release"

if [[ "${1:-}" != "--skip-build" ]]; then
  echo "==> building all workspaces (utils -> log -> browser -> extension -> host)"
  (cd "$REPO_ROOT" && bun run build)
fi

[[ -f "$EXT_DIR/dist/manifest.json" ]] || { echo "error: extension dist missing" >&2; exit 1; }
[[ -x "$HOST_DIR/bin/host" && -x "$HOST_DIR/bin/fn-browserd" ]] || { echo "error: host binaries missing" >&2; exit 1; }

# Pass the path via argv, not string interpolation — a repo path containing an
# apostrophe (e.g. .../O'Brien/...) would otherwise produce invalid Python.
VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$EXT_DIR/dist/manifest.json")"
ARCH="$(uname -m)"
NAME="fn-browser-$VERSION-darwin-$ARCH"
STAGE="$OUT_DIR/$NAME"

# Must match DEFAULT_EXTENSION_ID in apps/native-host/src/extension.ts (derived
# from the pinned key in the extension manifest — same on every machine).
EXTENSION_ID="kddgkpcbmpmafljodkcmdjccocmkbdon"

echo "==> staging $NAME"
rm -rf "$STAGE" "$OUT_DIR/$NAME.zip"
mkdir -p "$STAGE/extension" "$STAGE/host/bin" "$STAGE/host/install"

# Extension: dist minus sourcemaps (maps embed full workspace source).
(cd "$EXT_DIR/dist" && find . -type f ! -name '*.js.map' -exec rsync -R {} "$STAGE/extension/" \;)

cp "$HOST_DIR/bin/host" "$HOST_DIR/bin/fn-browserd" "$STAGE/host/bin/"
cp "$HOST_DIR/install/install.sh" "$STAGE/host/install/"
cp "$HOST_DIR/install-launchd.sh" "$HOST_DIR/fn-browserd-launch.sh" "$HOST_DIR/com.fn.browserd.plist" "$STAGE/host/"
chmod +x "$STAGE/host/install/install.sh" "$STAGE/host/install-launchd.sh" "$STAGE/host/fn-browserd-launch.sh"

LEAKED=$(find "$STAGE" -name '*.map' | wc -l | tr -d ' ')
[[ "$LEAKED" == "0" ]] || { echo "error: $LEAKED sourcemap(s) leaked into the bundle" >&2; exit 1; }

cat > "$STAGE/SETUP.md" <<EOF
# fn-browser $VERSION — setup (macOS, $ARCH)

Browser automation MCP for Claude Code: Claude drives your Chrome through a
local extension + native host. Consent prompts appear in the extension's side
panel for anything destructive.

## Verify the download (optional)

If you got this from a GitHub Release: the zip was built by GitHub Actions
from the tagged source (the release notes link the exact run — nothing here
was built on someone's laptop). Check integrity next to the downloaded zip:

    shasum -c SHA256SUMS --ignore-missing

Anyone with repo access can read the source that produced these binaries
(\`apps/native-host\`, \`apps/chrome-extension\`, \`packages/browser\`) or
rebuild the bundle themselves with \`scripts/release/bundle-browser.sh\`.

## Install (once, ~2 minutes)

1. **Put this folder somewhere permanent** (e.g. \`~/fn-browser\`). The install
   step embeds absolute paths — if you move the folder later, rerun step 3.

2. **Load the extension**: open \`chrome://extensions\`, enable **Developer
   mode**, click **Load unpacked**, select the \`extension/\` folder here.
   The extension ID will be \`$EXTENSION_ID\` (it's pinned — same everywhere).

3. **Install the native host**:

       bash host/install/install.sh

   (Use \`bash ...\`, not \`./...\` — macOS quarantines everything extracted
   from a downloaded zip and may refuse to execute the script directly.)
   This registers the host with every Chromium-family browser it finds,
   clears the macOS quarantine flag from the host binaries so Chrome can
   spawn them, and generates a private MCP token in \`~/.fn-browser/env\`.

4. **Register with Claude Code**: paste the \`claude mcp add ...\` command the
   installer printed (it includes your token).

5. **Restart Chrome** (or toggle the fn-browser extension off/on), then open
   the extension's side panel. In Claude Code, the \`fn-browser\` MCP tools
   (\`start\`, \`navigate\`, \`screenshot\`, ...) are now available.

## Optional: always-on daemon

By default Chrome spawns the host on demand. For a long-lived daemon that
survives Chrome restarts (and starts at login):

    bash host/install-launchd.sh

The daemon binds \`127.0.0.1:7722\` — the same port the on-demand shim uses.
If Chrome is running, the extension is already connected to the shim, which
holds that port, so \`fn-browserd\` can't bind and launchd will restart-loop it.
Before installing the daemon: quit Chrome (or disable the fn-browser extension),
run the command above, then reopen Chrome — the extension auto-detects the
running daemon and connects to it instead of spawning a shim.

The daemon is also what lets several Chrome profiles connect at once (load the
extension in each). The on-demand shim serves one profile at a time.

## Security notes

- The MCP endpoint (\`127.0.0.1:7722/mcp/browser\`) requires your bearer token,
  so other local processes can't drive your browser. Keep the token private —
  it's in \`~/.fn-browser/env\` (chmod 600).
- Destructive actions (clicks/forms/JS marked destructive) always prompt in
  the side panel unless you allowlist a site via "Always allow on <host>".
- Everything runs locally; run logs are \`~/.fn-browser/runs/\`, screenshots
  \`~/.fn-browser/screenshots/\`.

## Uninstall

Remove the folder, \`~/.fn-browser/\`, the extension in \`chrome://extensions\`,
and \`NativeMessagingHosts/com.fn.browser.json\` from your browser's
Application Support dir. If you installed the daemon:
\`launchctl unload ~/Library/LaunchAgents/com.fn.browserd.plist\` and delete
that plist.
EOF

echo "==> zipping"
(cd "$OUT_DIR" && zip -qr "$NAME.zip" "$NAME")
SIZE="$(du -h "$OUT_DIR/$NAME.zip" | cut -f1)"
echo "done: release/$NAME.zip ($SIZE)"
