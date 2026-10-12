#!/bin/sh
# Runs a run's codified spec against that run's slot. Used by the codify agent (its only shell access) and by replay.
set -eu
RUN_DIR="${1:?usage: try-spec.sh <run dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$RUN_DIR/replay.env"
ATTEMPT_DIR="$RUN_DIR/codify/attempts/$(date +%H%M%S)"
mkdir -p "$ATTEMPT_DIR"
cd "$ROOT/e2e"
E2E_OUTPUT_DIR="$ATTEMPT_DIR" E2E_SPEC_DIR="$E2E_SPEC_DIR" E2E_BASE_URL="$E2E_BASE_URL" E2E_STORAGE_STATE="$E2E_STORAGE_STATE" E2E_SLOWMO=0 \
  npx playwright test -c playwright.config.ts --reporter=line "$E2E_SPEC_FILE" 2>&1 | grep -v -E '^\s*$' | tail -60
