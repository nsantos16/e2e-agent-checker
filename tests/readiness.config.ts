import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'page-readiness.spec.ts',
  outputDir: '../runs/readiness/results',
  timeout: 15_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '../runs/readiness/report.json' }]],
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
