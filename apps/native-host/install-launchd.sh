#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS only" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BIN="$SCRIPT_DIR/bin/fn-browserd"

if [[ ! -f "$BIN" ]]; then
  echo "Binary not found at $BIN — run 'bun run --cwd apps/native-host build' first" >&2
  exit 1
fi

PLIST_SRC="$SCRIPT_DIR/com.fn.browserd.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.fn.browserd.plist"

sed_escape() {
  printf "%s" "$1" | sed 's/[&|]/\\&/g'
}

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/.fn-browser"

HOME_ESCAPED=$(sed_escape "$HOME")
HOST_DIR_ESCAPED=$(sed_escape "$SCRIPT_DIR")

sed \
  -e "s|__HOME__|$HOME_ESCAPED|g" \
  -e "s|__HOST_DIR__|$HOST_DIR_ESCAPED|g" \
  "$PLIST_SRC" > "$PLIST_DEST"

chmod +x "$SCRIPT_DIR/fn-browserd-launch.sh"
chmod +x "$SCRIPT_DIR/install-launchd.sh"

if [[ ! -f "$HOME/.fn-browser/env" ]]; then
  echo "⚠  Create ~/.fn-browser/env (chmod 600) with your secrets:"
  echo "   FN_BROWSER_AUTH_TOKENS=<clientname>:<token>:act"
  echo "   Leave FN_BROWSER_EXTENSION_TOKEN unset for local extension auto-detect."
fi

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "fn-browserd installed. Check: launchctl list | grep fn.browserd"
