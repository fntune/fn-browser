#!/usr/bin/env bash

set -euo pipefail

if [[ -f "$HOME/.fn-browser/env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$HOME/.fn-browser/env"
  set +a
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

exec "$SCRIPT_DIR/bin/fn-browserd" "$@"
