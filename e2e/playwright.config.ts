import { defineConfig } from '@playwright/test';

// Replay config for codified specs. The orchestrator sets the target slot, session, and artifact directory via env.

export default defineConfig({
  testDir: process.env.E2E_SPEC_DIR ?? './generated',
  outputDir: process.env.E2E_OUTPUT_DIR ?? '../runs/_replay',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: `${process.env.E2E_OUTPUT_DIR ?? '../runs/_replay'}/results.json` }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4001',
    storageState: process.env.E2E_STORAGE_STATE,
    testIdAttribute: 'data-testid',
    viewport: { width: 1280, height: 800 },
    video: { mode: 'on', size: { width: 1280, height: 800 } },
    trace: 'on',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO ?? 250) },
  },
});
