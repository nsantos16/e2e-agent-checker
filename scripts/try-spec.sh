#!/bin/sh
# Execute one stabilization attempt and retain its true exit code and output.
set -eu
RUN_DIR="${1:?usage: try-spec.sh <run dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${E2E_MANAGED_ATTEMPT:-0}" != 1 ]; then
  . "$RUN_DIR/replay.env"
fi
mkdir -p "$RUN_DIR/codify/attempts"
# The stage tool allocates the exact directory and a manifest sidecar before launch.
# Keep standalone invocations working, but they do not qualify for evidence promotion.
ATTEMPT_DIR="${2:-$(mktemp -d "$RUN_DIR/codify/attempts/attempt.XXXXXX")}"
cd "$ROOT/e2e"
RESULT=0
E2E_OUTPUT_DIR="$ATTEMPT_DIR" E2E_SPEC_DIR="$E2E_SPEC_DIR" E2E_BASE_URL="$E2E_BASE_URL" E2E_STORAGE_STATE="$E2E_STORAGE_STATE" E2E_SLOWMO=0 E2E_CAPTIONS=1 \
  npx playwright test -c playwright.config.ts "$E2E_SPEC_FILE" > "$ATTEMPT_DIR.log" 2>&1 || RESULT=$?
tail -80 "$ATTEMPT_DIR.log"
exit "$RESULT"
