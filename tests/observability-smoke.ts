// Tests the real verification browser transport and replay hook; no model calls or external app data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stageTools } from '../src/stage-tools.ts';
import { readNetwork, readObservation } from '../src/observations.ts';
import { replay } from '../src/replay.ts';
import { writeReplayEnv } from '../src/codify.ts';

const root = new URL('..', import.meta.url).pathname;
const runDir = mkdtempSync(join(root, 'runs/observation-smoke-'));
const dir = join(runDir, 'explore');
mkdirSync(dir);
const fixture = createServer((req, res) => {
  if (req.url?.startsWith('/api/fail')) {
    const body = JSON.stringify({
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Fixture service unavailable',
      token: 'do-not-retain',
      details: { reason: 'test failure', password: 'do-not-retain' },
    });
    res.writeHead(503, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-request-id': 'smoke-request-503',
    });
    res.end(body);
  } else if (req.url === '/api/drop') req.socket.destroy();
  else if (req.url === '/api/ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      "<h1>Network diagnostics fixture</h1><button onclick=\"fetch('/api/fail?token=do-not-retain').then(()=>document.querySelector('output').textContent='Service unavailable');fetch('/api/drop').catch(()=>{});fetch('/api/ok')\">Trigger errors</button><output></output>",
    );
  }
});
await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const hook = join(dir, 'observe.cjs');
writeFileSync(
  hook,
  `exports.default=({page})=>{require(${JSON.stringify(join(root, 'src/browser-observer.ts'))}).observeBrowser(page,${JSON.stringify({ runDir, artifactDir: dir, stage: 'explore' })});};`,
);
const config = join(dir, 'mcp.json');
writeFileSync(
  config,
  JSON.stringify({
    browser: { browserName: 'chromium', isolated: true, launchOptions: { headless: true }, initPage: [hook] },
    outputDir: join(dir, 'mcp-output'),
  }),
);
const browser = await stageTools({ browserConfig: config, runDir, actionsPath: join(dir, 'actions.js') });
const generated = mkdtempSync(join(root, 'e2e/generated/observation-smoke-'));
const specPath = join(generated, 'network.spec.ts');
const state = join(root, '.state/slot998-observation-smoke.json');
try {
  const nav = await browser.call('browser_navigate', { url: base });
  assert(!nav.isError, JSON.stringify(nav));
  const snapshot =
    nav.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n') +
    readdirSync(join(dir, 'mcp-output'))
      .filter((f) => f.endsWith('.yml'))
      .map((f) => readFileSync(join(dir, 'mcp-output', f), 'utf8'))
      .join('\n');
  const ref = snapshot.match(/button \"Trigger errors\" \[ref=([^\]]+)\]/)?.[1];
  assert(ref, snapshot);
  const action = await browser.call('browser_click', { target: ref, element: 'Trigger errors button' });
  assert(!action.isError, JSON.stringify(action));
  assert(
    action.content.some((c: any) => c.type === 'text' && c.text.includes('Network diagnostics') && c.text.includes('smoke-request-503')),
    'Browser tool result includes automatic failure context',
  );
  await new Promise((r) => setTimeout(r, 1800));
  const observation = readObservation(runDir, true);
  assert.equal(observation.browser?.status, 'active');
  assert(observation.browser?.frameAt);
  assert(existsSync(join(runDir, 'live/frame.jpg')));
  const diagnostic = await browser.call('qa_network_requests', { errorsOnly: true });
  const captured = JSON.parse(diagnostic.content[0].text);
  assert(
    captured.requests.some(
      (r: any) => r.status === 503 && r.requestId === 'smoke-request-503' && r.errorBody?.code === 'UPSTREAM_UNAVAILABLE',
    ),
  );
  assert(captured.requests.some((r: any) => r.failure));
  assert(!JSON.stringify(captured).includes('do-not-retain'));
  await browser.call('browser_close', {});
  await browser.close();
  mkdirSync(join(runDir, 'codify'));
  writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
  writeReplayEnv(runDir, generated, 'network.spec.ts', base, '998', 'observation-smoke');
  writeFileSync(
    specPath,
    `import {test,expect} from '@playwright/test';\nimport {qaseStep} from '../../qase-step';\ntest('network observation',async({page})=>{await qaseStep(page,1,'Trigger service failure',async()=>{await page.goto('/');await page.getByRole('button',{name:'Trigger errors'}).click();await expect(page.locator('output')).toHaveText('Service unavailable');});});`,
  );
  const codify = await stageTools({ specPath, runDir, readFiles: [], maxAttempts: 1 });
  const attempt = await codify.call('try_spec', {});
  assert(!attempt.isError, JSON.stringify(attempt));
  assert.match(attempt.content[0].text, /exit 0/);
  assert.match(attempt.content[0].text, /smoke-request-503/);
  const replayed = await replay({
    runDir,
    label: 'observation',
    specDir: generated,
    specFile: 'network.spec.ts',
    base,
    slot: '998',
    role: 'observation-smoke',
    slowMo: 0,
  });
  assert.equal(replayed.status, 'passed');
  assert(replayed.video && existsSync(replayed.video));
  const network = readNetwork(runDir, { errorsOnly: true });
  assert(network.capturedStages.includes('replay-observation'));
  assert(network.capturedStages.some((s) => s.startsWith('codify/')));
  assert(network.requests.some((r) => r.action === 'Step 1: Trigger service failure'));
  console.log(
    JSON.stringify(
      { runDir, browserPreview: 'captured', networkErrors: network.errorCount, stages: network.capturedStages, modelCalls: 0 },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  fixture.closeAllConnections();
  await new Promise<void>((r) => fixture.close(() => r()));
  rmSync(state, { force: true });
  rmSync(generated, { recursive: true, force: true });
}
