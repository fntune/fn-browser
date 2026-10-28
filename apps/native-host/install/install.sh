#!/usr/bin/env bash
# Installs the fn-browser native-messaging host manifest for every installed
# Chromium-family browser, and provisions ~/.fn-browser/env with an MCP bearer
# token on first run.
#
# Usage: install.sh [extension_id]
#
# The extension's manifest.json pins a public key, so Chrome assigns the SAME
# extension ID on every machine that loads the unpacked dist folder — the
# default below. Pass an ID only if you load a modified/unpinned build (open
# chrome://extensions, enable Developer mode, load the dist folder, copy it).

set -euo pipefail

# Must match DEFAULT_EXTENSION_ID in src/extension.ts (derived from the pinned
# `key` in the extension manifest).
DEFAULT_EXTENSION_ID="kddgkpcbmpmafljodkcmdjccocmkbdon"
EXTENSION_ID="${1:-$DEFAULT_EXTENSION_ID}"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NATIVE_HOST_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
BIN_PATH="$NATIVE_HOST_DIR/bin/host"

if [[ ! -x "$BIN_PATH" ]]; then
  echo "error: binary not built at $BIN_PATH" >&2
  echo "       run: bun run --cwd $NATIVE_HOST_DIR build" >&2
  exit 1
fi

# --- Gatekeeper: clear quarantine from the host dir (downloaded bundles) ---
#
# A bundle downloaded from a GitHub Release carries com.apple.quarantine, which
# propagates to every extracted file. The Bun-compiled binaries are only ad-hoc
# signed (not notarized), so Gatekeeper refuses to run a quarantined copy when
# Chrome spawns `host` — the install would silently fail on first connect.
# Scoped to the host dir only (binaries + launchd wrapper script); locally
# built copies have no quarantine attr and this is a no-op.

if [[ "$(uname -s)" == "Darwin" ]] && command -v xattr >/dev/null 2>&1; then
  if xattr -rd com.apple.quarantine "$NATIVE_HOST_DIR" 2>/dev/null; then
    :
  fi
  if [[ -n "$(xattr -l "$BIN_PATH" 2>/dev/null | grep com.apple.quarantine || true)" ]]; then
    echo "error: could not clear the macOS quarantine flag from $BIN_PATH" >&2
    echo "       run manually: xattr -rd com.apple.quarantine \"$NATIVE_HOST_DIR\"" >&2
    exit 1
  fi
  echo "gatekeeper: quarantine cleared for $NATIVE_HOST_DIR"
fi

# --- Native-messaging manifest: write into every installed browser's dir ---

case "$(uname -s)" in
  Darwin)
    BROWSER_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome"
      "$HOME/Library/Application Support/Chromium"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
      "$HOME/Library/Application Support/Arc/User Data"
      "$HOME/Library/Application Support/Microsoft Edge"
    )
    ;;
  Linux)
    BROWSER_DIRS=(
      "$HOME/.config/google-chrome"
      "$HOME/.config/chromium"
      "$HOME/.config/BraveSoftware/Brave-Browser"
      "$HOME/.config/microsoft-edge"
    )
    ;;
  *)
    echo "error: unsupported OS $(uname -s)" >&2
    exit 1
    ;;
esac

INSTALLED=0
for browser_dir in "${BROWSER_DIRS[@]}"; do
  # Only browsers that are actually installed (their profile dir exists) — a
  # manifest in a nonexistent browser's dir is harmless but misleading.
  [[ -d "$browser_dir" ]] || continue
  manifest_dir="$browser_dir/NativeMessagingHosts"
  mkdir -p "$manifest_dir"
  manifest_path="$manifest_dir/com.fn.browser.json"
  cat > "$manifest_path" <<JSON
{
  "name": "com.fn.browser",
  "description": "fn-browser native messaging host",
  "path": "$BIN_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
  echo "installed: $manifest_path"
  INSTALLED=$((INSTALLED + 1))
done

if [[ $INSTALLED -eq 0 ]]; then
  echo "error: no Chromium-family browser profile found (looked for Chrome, Chromium, Brave, Arc, Edge)" >&2
  exit 1
fi

echo "           path -> $BIN_PATH"
echo "           allowed_origins -> chrome-extension://$EXTENSION_ID/"

# --- MCP bearer token: provision ~/.fn-browser/env on first run ---
#
# The token gates the local MCP surface (http://127.0.0.1:7722/mcp/browser) so
# no other local process can drive the browser. FN_BROWSER_AUTH_SCOPE=mcp keeps
# the side-panel control routes on loopback trust (the panel holds no secrets).
# The host loads this file itself in shim mode; the launchd wrapper sources it.

FN_DIR="$HOME/.fn-browser"
ENV_FILE="$FN_DIR/env"
mkdir -p "$FN_DIR"

# Match both the plain and the `export `-prefixed assignment form — loadEnvFile
# and the launchd `source` both accept either, so the installer must recognize
# either to avoid appending a duplicate token entry.
TOKENS_RE='^[[:space:]]*(export[[:space:]]+)?FN_BROWSER_AUTH_TOKENS='
SCOPE_RE='^[[:space:]]*(export[[:space:]]+)?FN_BROWSER_AUTH_SCOPE='
BIND_RE='^[[:space:]]*(export[[:space:]]+)?FN_BROWSER_BIND='

read_last_env_value() {
  local pattern="$1"
  local value
  value="$(sed -nE "s/${pattern}//p" "$ENV_FILE" | tail -n 1)"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

is_loopback_bind() {
  local bind="${1:-127.0.0.1}"
  bind="$(printf '%s' "$bind" | tr '[:upper:]' '[:lower:]')"
  bind="${bind#[}"
  bind="${bind%]}"
  [[ "$bind" == "localhost" || "$bind" == "::1" || "$bind" =~ ^127\. ]]
}

TOKENS_VALUE=""
if [[ -f "$ENV_FILE" ]] && grep -Eq "$TOKENS_RE" "$ENV_FILE"; then
  TOKENS_VALUE="$(read_last_env_value "$TOKENS_RE")"
fi

# Prefer an act/admin-tier token for the printed command — the MCP browser
# controls (navigate/click) need act capability. The last assignment
# wins, matching both Bash `source` and loadEnvFile().
TOKEN="$(printf '%s' "$TOKENS_VALUE" \
  | tr ',' '\n' \
  | awk -F: 'NF>=3 && length($2)>0 && ($3=="admin"||$3=="act"){print $2; exit}')"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(printf '%s' "$TOKENS_VALUE" \
    | tr ',' '\n' \
    | awk -F: 'NF>=2 && length($2)>0{print $2; exit}')"
fi

if [[ -n "$TOKEN" ]]; then
  echo "token:     kept existing FN_BROWSER_AUTH_TOKENS in $ENV_FILE"
else
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 24)"
  else
    TOKEN="$(od -vAn -N24 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  # Prepend a newline if the file exists without a trailing one, so the first
  # assignment can't concatenate onto a preceding value.
  [[ -f "$ENV_FILE" && -s "$ENV_FILE" && -n "$(tail -c1 "$ENV_FILE")" ]] && echo "" >> "$ENV_FILE"
  echo "FN_BROWSER_AUTH_TOKENS=claude:$TOKEN:admin" >> "$ENV_FILE"
  echo "token:     generated MCP bearer token -> $ENV_FILE"

  # New local installs use MCP-only auth so the token-less side panel remains
  # available. Preserve an existing scope (including the default `all`) and do
  # not select MCP-only auth for a remote daemon configuration.
  if ! grep -Eq "$SCOPE_RE" "$ENV_FILE"; then
    BIND_VALUE="${FN_BROWSER_BIND:-}"
    if [[ -z "$BIND_VALUE" ]] && grep -Eq "$BIND_RE" "$ENV_FILE"; then
      BIND_VALUE="$(read_last_env_value "$BIND_RE")"
    fi
    if is_loopback_bind "$BIND_VALUE"; then
      echo "FN_BROWSER_AUTH_SCOPE=mcp" >> "$ENV_FILE"
      echo "scope:     added FN_BROWSER_AUTH_SCOPE=mcp to $ENV_FILE"
    else
      echo "scope:     kept default all for existing remote daemon configuration"
    fi
  fi
fi

# The token is browser-control authority. Enforce private permissions whether
# it was generated now or reused from an older install.
chmod 600 "$ENV_FILE"
echo "permissions: $ENV_FILE -> 600"

echo ""
echo "Register the MCP server with Claude Code:"
if [[ -n "$TOKEN" ]]; then
  echo ""
  echo "  claude mcp add --transport http --scope user fn-browser http://127.0.0.1:7722/mcp/browser \\"
  echo "    --header \"Authorization: Bearer $TOKEN\""
else
  echo ""
  echo "  (could not parse the existing token from $ENV_FILE — use the token from"
  echo "   its FN_BROWSER_AUTH_TOKENS entry as: --header \"Authorization: Bearer <token>\")"
fi
echo ""
echo "Then restart the browser (or reload the fn-browser extension) so it respawns the host."
