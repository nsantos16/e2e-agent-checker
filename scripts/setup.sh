#!/bin/sh
# One-time setup on a dev machine: dependencies, browsers for replay and for the agent, then a readiness check.
set -e
cd "$(dirname "$0")/.."
npm install
npx playwright install chromium
npx -y @playwright/mcp@0.0.83 install-browser chromium
node src/doctor.ts
