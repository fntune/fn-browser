#!/usr/bin/env bash
# Fails if any of the forbidden CDP domain-enable calls appear in the
# fn-browser source tree. See packages/browser/README.md for the rationale
# (detector-leaking CDP side channels: Runtime.enable, Console.enable,
# Debugger.enable, Page.evaluateOnNewDocument).
#
# The only allowed occurrences are inside the stealth-guard itself
# (packages/browser/src/cdp/send.ts) and the test that verifies it
# (packages/browser/src/__tests__/send.stealth.test.ts).

set -euo pipefail

cd "$(dirname "$0")/../.."

FORBIDDEN=(
  "Runtime\\.enable"
  "Console\\.enable"
  "Debugger\\.enable"
  "evaluateOnNewDocument"
)

ALLOWED_FILES=(
  "packages/browser/src/cdp/send.ts"
  "packages/browser/src/__tests__/send.stealth.test.ts"
  "packages/browser/scripts/check-stealth.sh"
  "packages/browser/README.md"
)

FAIL=0

for pattern in "${FORBIDDEN[@]}"; do
  echo "scanning for: $pattern"
  matches=$(grep -RIn --include="*.ts" --include="*.tsx" --include="*.md" \
    "$pattern" packages/browser apps/chrome-extension apps/native-host 2>/dev/null || true)

  if [[ -z "$matches" ]]; then
    continue
  fi

  while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    allowed=0
    for ok in "${ALLOWED_FILES[@]}"; do
      if [[ "$file" == "$ok" ]]; then
        allowed=1
        break
      fi
    done
    if [[ $allowed -eq 0 ]]; then
      echo "FORBIDDEN CDP call found: $line" >&2
      FAIL=1
    fi
  done <<< "$matches"
done

if [[ $FAIL -eq 1 ]]; then
  echo "" >&2
  echo "FAILED: forbidden CDP domain-enable calls leak execution-context-ids" >&2
  echo "that tier-1 bot detectors probe for. See packages/browser/README.md." >&2
  exit 1
fi

echo "OK: no forbidden CDP calls found"
