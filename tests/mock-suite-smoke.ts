// Real browser + native protocol fixture. No live model, login, backend, or paid API.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { chromium } from 'playwright';
import { mockBackendFixture, deriveFixtureSuite } from './fixtures/mock-backend.ts';
import { captureMockSources } from '../src/mock-sources.ts';
import { installMockNetwork } from '../src/mock-network.ts';
import { verifyEffect } from '../src/verify.ts';
import { CheckerLive } from '../src/runtime/services.ts';
import { runEffect } from '../src/runtime/effect.ts';
import { PricingCatalog } from '../src/pricing.ts';
import { atomicJson } from '../src/network.ts';
import { readSavedSpec, compatibilityContext, specRequirements, selectSavedSpec } from '../src/saved-specs.ts';
const root = new URL('..', import.meta.url).pathname;
mkdirSync(join(root, 'runs'), { recursive: true });
const dir = mkdtempSync(join(root, 'runs/mock-suite-smoke-'));
const f = mockBackendFixture(dir);
let broken = true,
  backendRequests = 0,
  pageVisits = 0;
const server = createServer((req, res) => {
  if (req.url !== '/') {
    backendRequests++;
    res.writeHead(500);
    res.end('Backend must not be contacted');
    return;
  }
  pageVisits++;
  res.setHeader('content-type', 'text/html');
  res.end(`<div data-testid="result">Loading</div><div data-testid="session"></div><script>
    document.querySelector('[data-testid="session"]').textContent = localStorage.getItem('visited') ? 'Leaked' : 'Fresh'; localStorage.setItem('visited','yes');
    fetch('/api/invoice?currency=USD').then(async r => { const b = await r.json(); document.querySelector('[data-testid="result"]').textContent = r.status === 403 ? ${JSON.stringify(broken ? 'Broken permission view' : 'Access denied')} : 'Paid: $' + b.amount; });
  </script>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const environment = {
  id: 'mock',
  revision: 'fixture-1',
  name: 'Mock fixture',
  kind: 'hosted' as const,
  baseUrl: base,
  devMode: 'test',
  users: [
    {
      id: 'qa',
      name: 'QA',
      usernameRef: 'env://UNUSED_USER',
      passwordRef: 'env://UNUSED_PASS',
    },
  ],
};
const old = {
  E2E_RUNS_DIR: process.env.E2E_RUNS_DIR,
  E2E_PROVIDERS_PATH: process.env.E2E_PROVIDERS_PATH,
  MOCK_PROVIDER_DIR: process.env.MOCK_PROVIDER_DIR,
};
process.env.E2E_RUNS_DIR = dir;
process.env.E2E_PROVIDERS_PATH = join(dir, 'providers.json');
process.env.MOCK_PROVIDER_DIR = dir;
const binary = join(dir, 'mock-provider');
writeFileSync(binary, `#!/usr/bin/env node\nimport(${JSON.stringify(join(root, 'tests/fixtures/mock-provider.ts'))});`, { mode: 0o755 });
atomicJson(process.env.E2E_PROVIDERS_PATH, {
  version: 1,
  instances: [
    {
      id: 'mock',
      provider: 'codex',
      name: 'Controlled fixture',
      binaryPath: binary,
      configDir: dir,
      enabled: true,
      options: {},
      revision: '1',
    },
  ],
});
const execute = (name: string, extra = {}) =>
  runEffect(
    verifyEffect({
      project: f.testCase.project,
      caseId: f.testCase.id,
      caseSnapshot: f.testCase,
      environment,
      base,
      role: 'qa',
      slot: 'mock',
      model: 'fixture',
      target: {
        instanceId: 'mock',
        provider: 'codex',
        model: 'fixture',
        authMode: 'subscription',
        options: { effort: 'max' },
      },
      mockSuite: f.input,
      runDir: join(dir, name),
      ...extra,
    }).pipe(
      Effect.provideService(PricingCatalog, {
        load: Effect.succeed({ catalog: null, source: 'none' as const }),
      }),
      Effect.provide(CheckerLive),
    ),
  );
try {
  const authored = await execute('authored');
  assert.equal(authored.specSelection.mode, 'author');
  assert.equal(authored.outcome, 'fail');
  assert.deepEqual(
    authored.replays[0].scenarios.map((s: any) => [s.id, s.status]),
    [
      ['success', 'passed'],
      ['permission', 'failed'],
    ],
  );
  const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.equal(calls.filter((c) => c.event === 'model-turn').length, 1);
  assert.equal(calls.find((c) => c.phase === 4).result.success, false, 'weakening a failed assertion must be rejected');
  assert.match(calls.find((c) => c.phase === 4).result.contentItems[0].text, /ASSERTIONS_LOCKED/);
  // Same suite and failing frontend must deterministically fail again, no new model.
  const failedReplay = await execute('failed-replay', {
    replayOnly: true,
    fromRun: join(dir, 'authored'),
  });
  assert.equal(failedReplay.outcome, 'fail');
  broken = false;
  const fixed = await execute('fixed');
  assert.equal(fixed.specSelection.mode, 'reuse');
  assert.equal(fixed.outcome, 'pass');
  const replay = await execute('replay-of-reuse', {
    replayOnly: true,
    fromRun: join(dir, 'fixed'),
  });
  assert.equal(replay.outcome, 'pass');
  assert.equal(
    readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter((s) => JSON.parse(s).event === 'model-turn').length,
    1,
  );
  for (const result of [authored, failedReplay, fixed, replay]) {
    assert.equal(result.coverage, 'mocked');
    assert.ok(existsSync(result.replays[0].video), result.replays[0].packagingError);
    assert.ok(existsSync(result.replays[0].trace));
    for (const s of result.replays[0].scenarios) {
      assert.ok(s.traffic.requests.some((r: any) => r.disposition === 'mocked'));
      assert.ok(existsSync(s.trace));
    }
  }
  const snapshot = captureMockSources(f.input);
  const context = {
    ...compatibilityContext(f.testCase, specRequirements(environment, environment.users[0], base)),
    mock: { fingerprint: snapshot.fingerprint },
  };
  const suitePath = join(dir, 'authored/mock/suite.json'),
    bytes = readFileSync(suitePath);
  const edited = JSON.parse(bytes.toString());
  edited.scenarios[0].mocks[0].responses[0].body.amount = 101;
  atomicJson(suitePath, edited);
  assert.equal(typeof readSavedSpec(join(dir, 'authored'), context), 'string');
  writeFileSync(suitePath, bytes);
  writeFileSync(join(f.backend, 'schema.json'), readFileSync(join(f.backend, 'schema.json'), 'utf8').replace('"minimum":0', '"minimum":1'));
  assert.equal(
    selectSavedSpec({
      ...context,
      mock: { fingerprint: captureMockSources(f.input).fingerprint },
    }).decision.mode,
    'author',
  );
  assert.equal(
    selectSavedSpec({
      ...context,
      case: { ...context.case, revision: 'changed' },
    }).decision.mode,
    'author',
  );
  // Real interception failure paths, without backend traffic or reused state.
  const browser = await chromium.launch();
  try {
    const suite = deriveFixtureSuite(snapshot);
    const scenario = suite.scenarios[0];
    for (const [label, url, options] of [
      ['wrong-method', '/api/invoice?currency=USD', { method: 'POST' }],
      ['wrong-query', '/api/invoice?currency=EUR', {}],
      ['wrong-body', '/api/invoice?currency=USD', { method: 'POST', body: '{}' }],
      ['unlisted-endpoint', '/api/unlisted', {}],
    ] as const) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const rows: any[] = [];
      const interceptor = await installMockNetwork(context, scenario, suite, f.input.allowedLiveRequests, base, (r) => {
        rows.splice(0, rows.length, ...r);
      });
      const page = await context.newPage();
      await page.goto(base);
      await page.getByTestId('result').getByText('Paid: $100').waitFor();
      await page.evaluate(
        async ({ url, options }) => {
          await fetch(url, options).catch(() => {});
        },
        { url, options },
      );
      assert.throws(() => interceptor.assertComplete(), /MOCK_NETWORK_FAILED/, label);
      assert(rows.some((r) => r.disposition === 'unexpected'));
      await context.close();
    }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const interceptor = await installMockNetwork(context, scenario, suite, f.input.allowedLiveRequests, base, () => {});
    const page = await context.newPage();
    await page.goto(base);
    await page.getByTestId('result').getByText('Paid: $100').waitFor();
    await page.evaluate(() => fetch('/api/invoice?currency=USD').catch(() => {}));
    assert.throws(() => interceptor.assertComplete(), /sequence exhausted/);
    await context.close();
    const postSuite = structuredClone(suite);
    const post = postSuite.scenarios[0].mocks[0];
    post.method = 'POST';
    post.body = { amount: 100 };
    post.responses.push({
      status: 409,
      headers: {},
      body: { error: 'Already paid' },
      unavailableContract: 'Matcher fixture',
    });
    const postContext = await browser.newContext({ serviceWorkers: 'block' });
    const postRows: any[] = [];
    const postGuard = await installMockNetwork(
      postContext,
      postSuite.scenarios[0],
      postSuite,
      [
        ...f.input.allowedLiveRequests,
        {
          method: 'GET',
          url: '/api/*',
          resourceTypes: ['fetch'],
          reason: 'Must not override protected endpoints',
        },
      ],
      base,
      (rows) => {
        postRows.splice(0, postRows.length, ...rows);
      },
    );
    const postPage = await postContext.newPage();
    // Set a frontend origin without the invoice page's automatic GET request.
    await postPage.route(base + '/blank', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture</h1>' }));
    await postPage.goto(base + '/blank');
    const responses = await postPage.evaluate(async (base) => {
      const statuses = [];
      for (let i = 0; i < 2; i++)
        statuses.push(
          (
            await fetch(base + '/api/invoice?currency=USD', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ amount: 100 }),
            })
          ).status,
        );
      return statuses;
    }, base);
    assert.deepEqual(responses, [200, 409]);
    postGuard.assertComplete();
    await postPage.evaluate(async (base) => {
      await fetch(base + '/api/invoice?currency=USD', {
        method: 'POST',
        body: JSON.stringify({ amount: 101 }),
      }).catch(() => {});
      await fetch(base + '/api/invoice?currency=USD').catch(() => {});
    }, base);
    assert.throws(() => postGuard.assertComplete(), /No matching mock/);
    assert.equal(postRows.filter((r) => r.disposition === 'unexpected').length, 2);
    await postContext.close();
  } finally {
    await browser.close();
  }
  assert.equal(backendRequests, 0);
  const measurements = {
    dir,
    authored: authored.outcome,
    successfulScenario: authored.replays[0].scenarios[0].status,
    failingScenario: authored.replays[0].scenarios[1].status,
    failedReplay: failedReplay.outcome,
    fixed: fixed.outcome,
    replayOfReuse: replay.outcome,
    modelFixtureTurns: 1,
    liveModelCalls: 0,
    backendRequests,
    pageVisits,
    evidence: [authored, failedReplay, fixed, replay].map((r) => ({
      runDir: r.runDir,
      video: r.replays[0].video,
      trace: r.replays[0].trace,
      results: r.replays[0].results,
    })),
  };
  atomicJson(join(dir, 'measurements.json'), measurements);
  console.log(JSON.stringify(measurements, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(old))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}
