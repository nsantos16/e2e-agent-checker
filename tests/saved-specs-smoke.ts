// Real Playwright replays against disposable localhost builds. No provider or
// model access; the saved spec and its historical report are explicit fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { CaseCatalog } from '../src/cases.ts';
import type { Environment } from '../src/environments.ts';
import { captureBuild, compatibilityContext, publishSavedSpec, specRequirements } from '../src/saved-specs.ts';
import { verifyEffect } from '../src/verify.ts';
import { specLocation } from '../src/codify.ts';
import { CheckerLive } from '../src/runtime/services.ts';
import { runEffect } from '../src/runtime/effect.ts';
import { ProviderRegistry } from '../src/providers/index.ts';
import { PricingCatalog } from '../src/pricing.ts';
import { ProcessRunner } from '../src/process.ts';

const root = new URL('..', import.meta.url).pathname;
mkdirSync(join(root, 'runs'), { recursive: true });
const dir = mkdtempSync(join(root, 'runs/saved-spec-smoke-'));
let text = 'Ready',
  oldVisits = 0,
  targetVisits = 0,
  preflights = 0,
  modelCalls = 0;
const old = createServer((_req, res) => {
  oldVisits++;
  res.end('<h1>Old build</h1>');
});
const target = createServer((_req, res) => {
  targetVisits++;
  res.setHeader('content-type', 'text/html');
  res.end(`<h1>${text}</h1>`);
});
const serve = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const oldBase = await serve(old),
  base = await serve(target);
const priorRoot = process.env.E2E_RUNS_DIR;
process.env.E2E_RUNS_DIR = dir;
const caseRecord = new CaseCatalog(join(dir, 'cases.json'), join(dir, 'fixtures')).create({
  title: 'Saved spec target',
  status: 'active',
  steps: [{ action: 'Open target', expected_result: 'Ready heading' }],
});
const environment: Environment = {
  id: 'smoke',
  name: 'Smoke',
  kind: 'worktree',
  revision: '1',
  devMode: 'fixture',
  users: [{ id: 'qa', name: 'QA', usernameRef: 'env://SMOKE_USER', passwordRef: 'env://SMOKE_PASSWORD' }],
};
const source = join(dir, 'source'),
  state = join(dir, 'state.json');
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
mkdirSync(join(source, 'explore'), { recursive: true });
mkdirSync(join(source, 'codify'), { recursive: true });
json(state, { cookies: [], origins: [] });
json(join(source, 'explore/case.json'), caseRecord);
json(join(source, 'explore/report.json'), {
  caseId: 1,
  verdict: 'fail',
  steps: [{ position: 1, verdict: 'fail', evidence: 'Historical fixture: old build was broken' }],
});
writeFileSync(
  join(source, 'codify/LOCAL-1.spec.ts'),
  `import { test, expect } from '@playwright/test';
import { qaseStep } from '../../qase-step';
test('saved target', async ({ page }) => {
  await qaseStep(page, 1, 'Ready heading', async () => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Ready', { timeout: 500 });
  });
});`,
);
publishSavedSpec(
  source,
  compatibilityContext(caseRecord, specRequirements(environment, environment.users[0], oldBase, root)),
  captureBuild(oldBase, root, 'old-fixture-build'),
);
const runner = await runEffect(ProcessRunner.pipe(Effect.provide(CheckerLive)));
const measurements: object[] = [];
try {
  for (const [name, expected] of [
    ['fixed-build', 'pass'],
    ['regressed-build', 'fail'],
  ] as const) {
    text = expected === 'pass' ? 'Ready' : 'Regression';
    const runDir = join(dir, name);
    const start = performance.now();
    const result = await runEffect(
      verifyEffect({
        project: 'LOCAL',
        caseId: 1,
        caseSnapshot: caseRecord,
        environment,
        worktree: root,
        base,
        role: 'qa',
        slot: 'reuse-smoke',
        storageState: state,
        runDir,
        buildId: name,
        model: 'unavailable',
        target: { provider: 'cursor', model: 'unavailable', authMode: 'subscription' },
      }).pipe(
        Effect.provideService(ProviderRegistry, {
          inspect: () => {
            preflights++;
            return Effect.die('Unexpected provider preflight');
          },
        }),
        Effect.provideService(PricingCatalog, { load: Effect.die('Unexpected pricing request') }),
        Effect.provideService(ProcessRunner, {
          execute: (command, args, options) => {
            if (['claude', 'codex', 'agent'].includes(command)) modelCalls++;
            return runner.execute(command, args, options);
          },
        }),
        Effect.provide(CheckerLive),
      ),
    );
    assert.equal(result.specSelection.mode, 'reuse');
    assert.equal(result.outcome, expected);
    assert.equal(result.verification.steps[0].verdict, expected);
    assert.equal(result.historicalExploration.verdict, 'fail');
    assert.equal(result.replays[0].base, base);
    assert.ok(existsSync(result.replays[0].trace));
    assert.ok(existsSync(result.replays[0].video), result.replays[0].packagingError);
    assert.equal(existsSync(join(runDir, 'explore/network.json')), false);
    assert.ok(existsSync(join(runDir, 'replay-slotreuse-smoke/network.json')));
    const history = JSON.parse(readFileSync(join(runDir, 'historical/explore-report.json'), 'utf8'));
    assert.equal(history.provenance.historical, true);
    measurements.push({
      buildId: name,
      outcome: result.outcome,
      wallMs: Math.round(performance.now() - start),
      replayMs: result.replays[0].wallMs,
      modelCalls,
      preflights,
      video: result.replays[0].video,
      trace: result.replays[0].trace,
    });
  }
  assert.equal(oldVisits, 0, 'saved target must never be visited');
  assert.ok(targetVisits >= 2);
  assert.equal(modelCalls, 0);
  assert.equal(preflights, 0);
  json(join(dir, 'measurements.json'), {
    measurements,
    oldVisits,
    targetVisits,
    note: 'Actual replay timings; fixture-authored spec. No paired live model benchmark or latency/cost savings estimate.',
  });
  console.log(JSON.stringify({ dir, measurements, oldVisits, targetVisits }, null, 2));
} finally {
  for (const name of ['fixed-build', 'regressed-build'])
    rmSync(specLocation(join(dir, name), 'LOCAL', 1).specDir, { recursive: true, force: true });
  if (priorRoot === undefined) delete process.env.E2E_RUNS_DIR;
  else process.env.E2E_RUNS_DIR = priorRoot;
  await Promise.all([old, target].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
}
