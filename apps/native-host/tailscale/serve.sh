#!/usr/bin/env bash
#
# Phase 2 (Tailscale A): expose fn-browserd over the tailnet using the system
# tailscaled + `tailscale serve`. The daemon binds loopback; tailscale serve
# proxies tailnet HTTPS -> 127.0.0.1:PORT. This is the "bootstrap" path; the
# self-contained tsnet sidecar (apps/fn-browser-tsnet) is the native target.
#
# Refuses to expose an unauthenticated daemon: set FN_BROWSER_AUTH_TOKENS
# (bearer) and/or FN_BROWSER_IDENTITY_TIERS (+FN_BROWSER_TRUST_IDENTITY_HEADER=1)
# before running.
#
# Flag spelling for `tailscale serve` varies across Tailscale versions; adjust
# the final line if your CLI differs (see `tailscale serve --help`).
set -euo pipefail

PORT="${FN_BROWSER_PORT:-7722}"

# Identity tiers only authenticate when the daemon ALSO trusts the injected
# header (FN_BROWSER_TRUST_IDENTITY_HEADER=1) — otherwise fn-browserd stays a
# no-auth local-admin daemon and this would publish it unauthenticated.
identity_auth=""
if [[ -n "${FN_BROWSER_IDENTITY_TIERS:-}" && "${FN_BROWSER_TRUST_IDENTITY_HEADER:-}" == "1" ]]; then
  identity_auth="1"
fi
if [[ -z "${FN_BROWSER_AUTH_TOKENS:-}" && -z "$identity_auth" ]]; then
  echo "refusing to expose fn-browserd over the tailnet unauthenticated." >&2
  echo "set FN_BROWSER_AUTH_TOKENS, or FN_BROWSER_IDENTITY_TIERS with FN_BROWSER_TRUST_IDENTITY_HEADER=1." >&2
  exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale CLI not found. Install Tailscale, or use the tsnet sidecar (Phase 3)." >&2
  exit 1
fi

# The extension token is the only UNFORGEABLE secret for /ws/extension over the
# tailnet — a tailnet client can set `Origin: chrome-extension://<id>` by hand,
# so FN_BROWSER_EXTENSION_ID alone is not enough. Require the token explicitly
# (and start fn-browserd with the same value); the /ws/extension probe below is
# defense-in-depth, not a substitute, since an id-pinned no-token daemon also
# 403s the un-credentialed probe.
if [[ -z "${FN_BROWSER_EXTENSION_TOKEN:-}" ]]; then
  echo "set FN_BROWSER_EXTENSION_TOKEN (and start fn-browserd with it): serve proxies /ws/extension to the tailnet." >&2
  exit 1
fi
# The /ws/extension token probe must use the daemon's real pinned Origin to tell
# an Origin rejection apart from a token rejection — so require (and match) the
# same extension id the daemon was started with.
if [[ -z "${FN_BROWSER_EXTENSION_ID:-}" ]]; then
  echo "set FN_BROWSER_EXTENSION_ID to the same value fn-browserd was started with (needed to probe /ws/extension token-gating)." >&2
  exit 1
fi

# Prove the RUNNING daemon enforces auth (env vars here don't prove how
# fn-browserd was actually started). Two probes, both against the live daemon:
#
#   1. HTTP surface — an unauthenticated /health must return 401.
#   2. Extension WS — probe /ws/extension with a chrome-extension Origin (the
#      pinned id when set) and NO token. That passes any Origin/id pin, so a 403
#      proves the daemon actually requires the token; 426/101 means a tailnet
#      client could spoof the Origin and hijack the extension link.
health="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "000")"
if [[ "$health" != "401" ]]; then
  echo "daemon at 127.0.0.1:${PORT} did not return 401 to an unauthenticated /health probe (got ${health})." >&2
  echo "start fn-browserd with auth enabled before serving — refusing to publish it unauthenticated." >&2
  exit 1
fi
probe_origin="chrome-extension://${FN_BROWSER_EXTENSION_ID}"
# (1) Tokenless with the pinned Origin must be REJECTED (403) — token required.
ws_notoken="$(curl -s -o /dev/null -w "%{http_code}" -H "Origin: ${probe_origin}" "http://127.0.0.1:${PORT}/ws/extension" 2>/dev/null || echo "000")"
if [[ "$ws_notoken" != "403" ]]; then
  echo "daemon at 127.0.0.1:${PORT} did not require the extension token on /ws/extension (got ${ws_notoken} for a tokenless probe with the pinned Origin; expected 403)." >&2
  echo "start fn-browserd with FN_BROWSER_EXTENSION_TOKEN — serve would otherwise expose the extension link." >&2
  exit 1
fi
# (2) With the configured token+Origin it must be ACCEPTED to upgrade (426 for a
# plain GET). Anything else means this script's TOKEN/ID don't match the running
# daemon, so probe (1) only passed on an Origin pin — refuse.
ws_token="$(curl -s -o /dev/null -w "%{http_code}" -H "Origin: ${probe_origin}" "http://127.0.0.1:${PORT}/ws/extension?token=${FN_BROWSER_EXTENSION_TOKEN}" 2>/dev/null || echo "000")"
if [[ "$ws_token" != "426" ]]; then
  echo "daemon at 127.0.0.1:${PORT} rejected the configured token/Origin (got ${ws_token}, expected 426 upgrade)." >&2
  echo "FN_BROWSER_EXTENSION_ID/FN_BROWSER_EXTENSION_TOKEN here must match the values fn-browserd was started with." >&2
  exit 1
fi

# Run Serve in the FOREGROUND (no --bg): `--bg` persists across daemon restarts,
# so if fn-browserd is later restarted without auth the stale proxy would publish
# it unauthenticated. Foreground ties exposure to this process — killing it tears
# the tailnet exposure down.
echo "exposing fn-browserd (127.0.0.1:${PORT}) over the tailnet via 'tailscale serve'…"
tailscale serve "http://127.0.0.1:${PORT}" &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT INT TERM

# Continuously re-probe the daemon's auth (like the tsnet sidecar's watcher). The
# one-shot probes above only cover startup; if fn-browserd later restarts WITHOUT
# HTTP auth, /health stops returning 401 — stop Serve so it never publishes an
# unauthenticated browser-control surface. 401 = auth required (good); 000 =
# daemon momentarily down (transient, keep waiting); anything else = auth gone.
while kill -0 "$SERVE_PID" 2>/dev/null; do
  sleep 30
  health="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "000")"
  if [[ "$health" != "401" && "$health" != "000" ]]; then
    echo "daemon at 127.0.0.1:${PORT} no longer requires auth (got ${health}) — stopping tailscale serve." >&2
    kill "$SERVE_PID" 2>/dev/null || true
    exit 1
  fi
done
