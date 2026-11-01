// Real compiled UI + local API; no model calls, speech calls, or GitHub publication.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { command } from '../src/process.ts';
import { ensureFrontend } from '../src/app/frontend.ts';

const root = new URL('..', import.meta.url).pathname;
mkdirSync(join(root, 'runs'), { recursive: true });
const dir = mkdtempSync(join(root, 'runs/demo-ui-smoke-'));
const replay = join(dir, 'replay');
mkdirSync(replay);
const video = join(replay, 'verification.mp4');
assert.equal(
  (
    await command('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:r=25:d=2',
      '-an',
      '-c:v',
      'libx264',
      video,
    ])
  ).code,
  0,
);
writeFileSync(
  join(replay, 'timeline.json'),
  JSON.stringify({
    version: 1,
    clock: 'wall',
    closedAt: 2000,
    steps: [
      {
        position: 1,
        title: 'Save note',
        status: 'failed',
        startedAt: 250,
        endedAt: 1700,
      },
    ],
  }),
);
const jobs = [
  {
    id: 'ui-demo',
    project: 'LOCAL',
    caseId: 1,
    status: 'done',
    outcome: 'fail',
    batchId: 'ui-session',
    worktree: '',
    role: 'qa',
    createdAt: new Date().toISOString(),
    runDir: dir,
    video,
    replay: { status: 'failed' },
    steps: [{ position: 1, verdict: 'fail', evidence: 'Save was rejected' }],
    log: [],
  },
];
writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobs));
const probe = createServer();
await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
const port = (probe.address() as any).port;
await new Promise<void>((r) => probe.close(() => r()));
await ensureFrontend();
const app = spawn(process.execPath, ['src/app/server.ts'], {
  env: {
    ...process.env,
    E2E_APP_PORT: String(port),
    E2E_APP_OPEN: '0',
    E2E_JOBS_PATH: join(dir, 'jobs.json'),
    E2E_STATE_DIR: join(dir, 'state'),
    E2E_CASES_PATH: join(dir, 'cases.json'),
    E2E_ENVIRONMENTS_PATH: join(dir, 'environments.json'),
  },
  stdio: 'ignore',
});
const closed = new Promise<void>((r) => app.once('exit', () => r()));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(base + '/api/config').then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const checkLayout = async (selector: string) => {
    const problems = await page.locator(selector).evaluate((root) => {
      const area = root.getBoundingClientRect();
      const minimumFieldWidth = root.classList.contains('composer-toolbar') ? 120 : 160;
      const controls = [...root.querySelectorAll<HTMLElement>('select, input:not([type="checkbox"]), button')]
        .map((el) => ({
          name: el.getAttribute('aria-label') || el.id || el.textContent?.trim(),
          tag: el.tagName,
          rect: el.getBoundingClientRect(),
        }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0);
      const issues: string[] = [];
      for (const [i, control] of controls.entries()) {
        const { rect, name, tag } = control;
        if (rect.left < area.left - 1 || rect.right > area.right + 1) issues.push(`${name} overflows its panel`);
        if (tag !== 'BUTTON' && rect.width < Math.min(minimumFieldWidth, area.width - 40)) {
          issues.push(`${name} is collapsed (${rect.width}px at viewport ${innerWidth}px)`);
        }
        for (const other of controls.slice(i + 1)) {
          if (
            Math.min(rect.right, other.rect.right) - Math.max(rect.left, other.rect.left) > 1 &&
            Math.min(rect.bottom, other.rect.bottom) - Math.max(rect.top, other.rect.top) > 1
          ) {
            issues.push(`${name} overlaps ${other.name}`);
          }
        }
      }
      return issues;
    });
    assert.deepEqual(problems, [], `${selector}: fields remain readable and separate`);
  };
  await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/doctor*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/worktrees', (route) => route.fulfill({ json: [] }));
  let publicationCalls = 0;
  await page.route('**/api/publish', (route) => {
    publicationCalls++;
    return route.fulfill({ json: { posted: 'fixture-only' } });
  });
  await page.goto(base + '/?job=ui-demo');
  await page.getByRole('button', { name: 'Generate summary', exact: true }).click();
  await page.locator('.session-markdown').waitFor();
  assert.match(await page.locator('.session-markdown').innerText(), /Save was rejected/);
  assert.equal(publicationCalls, 0, 'opening a summary does not publish');
  const originalPlayer = await page.locator('.detail > video').elementHandle();
  await page.getByRole('button', { name: 'Generate demo', exact: true }).click();
  await page.getByText('Silent replay · silent', { exact: true }).waitFor();
  assert.equal((await (await fetch(base + '/api/jobs/ui-demo/demos')).json()).demos.length, 1);
  await page.locator('#settings-open').click();
  await page.getByRole('tab', { name: 'Voice narration', exact: true }).click();
  await page.getByRole('button', { name: 'Save voice settings', exact: true }).waitFor();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout('#voice-settings');
  }
  await page.getByLabel('Enable voice by default for requested demos').check();
  await page.locator('#voice-settings').getByLabel('Narration voice', { exact: true }).selectOption('cedar');
  await page.getByRole('button', { name: 'Save voice settings', exact: true }).click();
  await page.getByText('Voice narration settings saved.', { exact: true }).waitFor();
  const settings = await (await fetch(base + '/api/settings/voice')).json();
  assert.equal(settings.settings.enabled, true);
  assert.equal(settings.settings.voice, 'cedar');
  await page.locator('[data-close="settings-dialog"]').click();
  await page.getByLabel('Demo voice narration').selectOption('off');
  await page.getByRole('button', { name: 'Generate demo', exact: true }).click();
  assert.equal(await originalPlayer!.evaluate((el) => el.isConnected), true, 'settings and demo generation preserve the silent player');
  await page.getByLabel('Demo voice narration').selectOption('on');
  await page.getByRole('button', { name: 'Generate demo', exact: true }).click();
  await page.getByText(/AI-generated voice narration · error/).waitFor();
  const after = await (await fetch(base + '/api/jobs/ui-demo/demos')).json();
  assert.ok(after.demos.some((d: any) => d.error?.code === 'CREDENTIAL_UNAVAILABLE'));
  assert.equal((await (await fetch(base + '/api/jobs/ui-demo')).json()).outcome, 'fail');
  const generated = after.demos.length;
  await page.reload();
  await page.getByRole('button', { name: 'Generate demo', exact: true }).waitFor();
  assert.equal(
    (await (await fetch(base + '/api/jobs/ui-demo/demos')).json()).demos.length,
    generated,
    'opening an existing run never generates audio',
  );
  await page.getByRole('button', { name: 'Generate summary', exact: true }).click();
  await page.getByText('Combine runs into an explicit session', { exact: true }).click();
  await page.getByText('Publish to a pull request', { exact: true }).click();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout('.composer-toolbar');
    await checkLayout('.demo-panel');
    await checkLayout('.session-panel');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page fits the viewport');
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      voiceSettings: 'persisted via UI',
      sessionSummary: 'visible',
      silentOverride: 'verified',
      missingCredential: 'reported without changing outcome',
      publicationCalls,
      modelCalls: 0,
    }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  // Existing browser regressions use API fixtures inside an isolated iframe.
  for (const suite of ['app-playback.browser.js', 'app-workspace.browser.js']) {
    const result = (await page.evaluate(readFileSync(join(root, 'tests', suite), 'utf8'))) as any;
    assert.equal(result.failed, undefined, `${suite}: ${JSON.stringify(result)}`);
    console.log(`${suite}: ${result.passed} checks passed`);
  }
} finally {
  await browser.close();
  app.kill('SIGTERM');
  await closed;
  rmSync(dir, { recursive: true, force: true });
}
