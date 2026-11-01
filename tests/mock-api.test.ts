import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, expect } from '@playwright/test';
import { mockBackendFixture } from './fixtures/mock-backend.ts';
import { atomicJson } from '../src/network.ts';

test(
  'MCP/API/UI carry mock inputs through jobs, isolated replay, evidence and session summaries without login',
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'checker-mock-api-'));
    const f = mockBackendFixture(dir);
    let backendRequests = 0;
    const frontend = createServer((req, res) => {
      if (req.url !== '/') {
        backendRequests++;
        res.writeHead(500);
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        `<div data-testid="session">Fresh</div><div data-testid="result"></div><script>fetch('/api/invoice?currency=USD').then(async r => {const b=await r.json(); document.querySelector('[data-testid="result"]').textContent=r.ok?'Paid: $'+b.amount:'Access denied';});</script>`,
      );
    });
    await new Promise<void>((r) => frontend.listen(0, '127.0.0.1', r));
    const targetBase = `http://127.0.0.1:${(frontend.address() as { port: number }).port}`;
    const portProbe = createServer();
    await new Promise<void>((r) => portProbe.listen(0, '127.0.0.1', r));
    const port = (portProbe.address() as { port: number }).port;
    await new Promise<void>((r) => portProbe.close(() => r()));
    const binary = join(dir, 'provider');
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('./fixtures/mock-provider.ts', import.meta.url).pathname)});`,
      { mode: 0o755 },
    );
    atomicJson(join(dir, 'providers.json'), {
      version: 1,
      instances: [
        {
          id: 'mock',
          provider: 'codex',
          name: 'Fixture',
          binaryPath: binary,
          configDir: dir,
          enabled: true,
          options: {},
          revision: '1',
        },
      ],
    });
    atomicJson(join(dir, 'environments.json'), [
      {
        id: 'mock',
        revision: '1',
        name: 'Mock fixture',
        kind: 'hosted',
        baseUrl: targetBase,
        devMode: 'test',
        users: [
          {
            id: 'qa',
            name: 'QA',
            usernameRef: 'env://MISSING_MOCK_USER',
            passwordRef: 'env://MISSING_MOCK_PASSWORD',
          },
        ],
      },
    ]);
    const env = {
      ...process.env,
      E2E_APP_PORT: String(port),
      E2E_APP_OPEN: '0',
      E2E_STATE_DIR: dir,
      E2E_JOBS_PATH: join(dir, 'jobs.json'),
      E2E_CASES_PATH: join(dir, 'cases.json'),
      E2E_ENVIRONMENTS_PATH: join(dir, 'environments.json'),
      E2E_PROVIDERS_PATH: join(dir, 'providers.json'),
      E2E_SETTINGS_PATH: join(dir, 'settings.json'),
      E2E_RUNS_DIR: join(dir, 'runs'),
      MOCK_PROVIDER_DIR: dir,
    } as Record<string, string>;
    mkdirSync(env.E2E_RUNS_DIR);
    const app = spawn(process.execPath, ['src/app/server.ts'], {
      env,
      stdio: 'pipe',
    });
    let logs = '';
    app.stdout.on('data', (d) => {
      logs += d;
    });
    app.stderr.on('data', (d) => {
      logs += d;
    });
    const exited = new Promise<void>((r) => app.once('exit', () => r()));
    const base = `http://127.0.0.1:${port}`;
    const client = new Client({ name: 'mock-api-test', version: '1' });
    const browser = await chromium.launch();
    const call = async (name: string, args: object) => {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, { timeout: 60_000 });
      assert(!result.isError, JSON.stringify(result));
      return (result.structuredContent as any).data;
    };
    try {
      let ready = false;
      for (let i = 0; i < 200; i++) {
        ready = await fetch(base + '/api/config').then(
          (r) => r.ok,
          () => false,
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(ready, logs);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['src/mcp-server.ts'],
          env,
          stderr: 'pipe',
        }),
      );
      const tools = await client.listTools();
      assert((tools.tools.find((t) => t.name === 'verify_case')!.inputSchema.properties as any).mockSuite);
      // Configuration is usable at desktop and mobile widths, and the mode is explicit.
      const page = await browser.newPage();
      await page.goto(base);
      await page.locator('#options-open').click();
      await page.locator('#coverage-mode').click();
      await page.getByRole('option', { name: 'Backend-derived mocks', exact: false }).click();
      await page.locator('#mock-backend').fill(f.backend);
      await page.locator('#mock-sources').fill(f.input.sourceFiles.join('\n'));
      await page.locator('#mock-schemas').fill('schema.json');
      await page.locator('#mock-live').fill(JSON.stringify(f.input.allowedLiveRequests));
      await expect(page.locator('#mock-sources')).toHaveValue('routes.ts\nservice.ts');
      await page.setViewportSize({ width: 390, height: 844 });
      assert(await page.locator('#options-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      const request = {
        project: 'LOCAL',
        caseId: f.testCase.id,
        environmentId: 'mock',
        userId: 'qa',
        mockSuite: f.input,
        target: {
          provider: 'codex',
          instanceId: 'mock',
          model: 'fixture',
          options: { effort: 'max' },
        },
        idempotencyKey: 'mock-fixture',
      };
      const submitted = await call('verify_case', request);
      assert.equal((await call('verify_case', request)).jobId, submitted.jobId);
      let job = await call('get_job', { jobId: submitted.jobId });
      while (!job.terminal) {
        await call('wait_jobs', { jobIds: [submitted.jobId], waitMs: 25000 });
        job = await call('get_job', { jobId: submitted.jobId });
      }
      assert.equal(job.outcome, 'pass', JSON.stringify(job));
      assert.equal(job.coverage, 'mocked');
      const evidence = await call('get_evidence', { jobId: job.id });
      assert(evidence.artifacts.some((a: any) => a.id === 'mock-suite'));
      assert(evidence.artifacts.some((a: any) => a.id === 'mock-sources'));
      assert.match(
        (
          await call('get_evidence', {
            jobId: job.id,
            artifact: 'mock-sources',
            limit: 16000,
          })
        ).text,
        /service.ts/,
      );
      const summary = await call('get_session_summary', {
        sessionId: job.sessionId,
      });
      assert.match(summary.markdown, /Mocked frontend coverage/);
      assert.equal(summary.runs[0].scenarios.length, 2);
      const history = await (await fetch(base + '/api/jobs/' + job.id)).json();
      assert.deepEqual(history.mockSuite, {
        ...f.input,
        backendRoot: realpathSync(f.input.backendRoot),
      });
      await page.goto(base + '/?job=' + job.id);
      await expect(page.getByText('Mocked frontend coverage', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Suite and fixtures' })).toBeVisible();
      const replay = await call('replay_job', { jobId: job.id });
      let next = await call('get_job', { jobId: replay.jobId });
      while (!next.terminal) {
        await call('wait_jobs', { jobIds: [next.id], waitMs: 25000 });
        next = await call('get_job', { jobId: next.id });
      }
      assert.equal(next.outcome, 'pass', JSON.stringify(next));
      assert.equal(next.coverage, 'mocked');
      assert.equal(next.sessionId, job.sessionId);
      assert.equal(backendRequests, 0);
      assert.equal(
        readFileSync(join(dir, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter((line) => JSON.parse(line).event === 'model-turn').length,
        1,
      );
    } finally {
      await client.close();
      await browser.close();
      app.kill('SIGTERM');
      await exited;
      await new Promise<void>((r) => frontend.close(() => r()));
      // Run directories are disposable; generated specs contain only this fixture's data.
      for (const job of existsSync(env.E2E_JOBS_PATH) ? JSON.parse(readFileSync(env.E2E_JOBS_PATH, 'utf8')) : [])
        if (job.runDir)
          rmSync(new URL('../e2e/generated/' + job.runDir.split('/').at(-1), import.meta.url).pathname, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
