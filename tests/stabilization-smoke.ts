// Local Playwright/ffmpeg regression. No provider calls or credentials are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Effect } from 'effect';
import { evidenceFixture } from './fixtures/evidence.ts';
import { verifyEffect } from '../src/verify.ts';
import { specLocation } from '../src/codify.ts';
import { stageTools, type StageConfig } from '../src/stage-tools.ts';
import { CaseCatalog } from '../src/cases.ts';
import { ProviderRegistry } from '../src/providers/index.ts';
import { PricingCatalog } from '../src/pricing.ts';
import { ProcessRunner, ProcessRunnerLive, commandEffect, type CommandOptions } from '../src/process.ts';
import { runEffect, sdk } from '../src/runtime/effect.ts';
import { CheckerLive } from '../src/runtime/services.ts';

const measurements = [];
for (const scenario of [
  'pass',
  'product-failure',
  'confirmation',
  'additional-target',
  'missing-recording',
  'malformed-manifest',
  'changed-build',
  'changed-spec',
]) {
  const f = evidenceFixture(true);
  const additionalSlot = `smoke-${basename(f.dir)}`;
  let executions = 0;
  const server = createServer((req, res) => {
    if (req.url === '/execute') executions++;
    res.setHeader('content-type', 'text/html');
    res.end('<h1 data-testid="value">Ready</h1>');
  });
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;
  const slots = Object.fromEntries(
    ['fixture', additionalSlot].map((slot) => [slot, { slot, port, pid: process.pid, worktree: f.worktree, role: 'qa' }]),
  );
  writeFileSync(process.env.E2E_SLOTS_PATH!, JSON.stringify(slots));
  const cases = new CaseCatalog(join(f.dir, 'cases.json'), join(f.dir, 'fixtures'));
  const testCase = cases.create({
    title: `Evidence ${scenario}`,
    status: 'active',
    steps: [{ action: 'Open fixture', expected_result: 'Ready' }],
  });
  const failed = scenario === 'product-failure';
  const spec = specLocation(f.runDir, testCase.project, testCase.id);
  const run = verifyEffect({
    project: testCase.project,
    caseId: testCase.id,
    caseSnapshot: testCase,
    runDir: f.runDir,
    slot: 'fixture',
    role: 'qa',
    base,
    storageState: f.context.storageState,
    model: 'fixture-model',
    confirmationReplay: scenario === 'confirmation',
    replaySlots: scenario === 'additional-target' ? [additionalSlot] : [],
  }).pipe(
    Effect.provideService(ProviderRegistry, {
      inspect: (id) =>
        Effect.succeed({
          id,
          name: 'Fixture',
          installed: true,
          auth: 'subscription',
          ready: true,
          loginCommand: 'unused',
          models: [{ id: 'fixture-model', name: 'Fixture' }],
        }),
    }),
    Effect.provideService(PricingCatalog, { load: Effect.succeed({ catalog: {}, source: 'cache' as const }) }),
    Effect.provideService(ProcessRunner, {
      execute: (name: string, args: string[], opts: CommandOptions = {}) => {
        if (name !== 'claude') return commandEffect(name, args, opts).pipe(Effect.provide(ProcessRunnerLive));
        return Effect.gen(function* () {
          const codify = opts.cwd?.endsWith('/codify');
          if (codify) {
            const config: StageConfig = JSON.parse(readFileSync(join(opts.cwd!, 'stage-config.json'), 'utf8'));
            const service = yield* sdk(() => stageTools(config));
            try {
              yield* sdk(() =>
                service.call('write_spec', {
                  source: `
import { test, expect } from '@playwright/test';
import { qaseStep } from '../../qase-step';
test('evidence fixture', async ({ page }) => {
  await qaseStep(page, 1, 'Check ready state', async () => {
    await page.goto('/execute');
    await expect(page.getByTestId('value')).toHaveText('${failed ? 'Wrong' : 'Ready'}', { timeout: 250 });
  });
});
`,
                }),
              );
              const attempt = yield* sdk(() => service.call('try_spec', {}));
              assert.equal(attempt.isError, false, JSON.stringify(attempt));
            } finally {
              yield* sdk(() => service.close());
            }
          }
          if (codify) {
            if (scenario === 'missing-recording') {
              const last = JSON.parse(readFileSync(join(f.runDir, 'codify/last-attempt.json'), 'utf8'));
              for (const artifact of last.artifacts) if (artifact.path.endsWith('.webm')) rmSync(artifact.path);
            }
            if (scenario === 'malformed-manifest') writeFileSync(join(f.runDir, 'codify/last-attempt.json'), '{');
            if (scenario === 'changed-build') writeFileSync(join(f.worktree, 'app.html'), '<h1>New build</h1>');
            if (scenario === 'changed-spec')
              writeFileSync(spec.specPath, readFileSync(spec.specPath, 'utf8') + '\n// Spec changed after its attempt\n');
          }
          const result = codify
            ? { specPath: spec.specPath, attempts: 1, outcome: failed ? 'failed-as-expected' : 'passed', failingStep: failed ? 1 : null }
            : {
                caseId: testCase.id,
                verdict: failed ? 'fail' : 'pass',
                steps: [{ position: 1, verdict: failed ? 'fail' : 'pass', evidence: 'Checked fixture' }],
              };
          opts.onLine?.(JSON.stringify({ type: 'result', result: JSON.stringify(result), usage: { input_tokens: 0, output_tokens: 0 } }));
          return { code: 0, stdout: '', stderr: '' };
        });
      },
    }),
    Effect.provide(CheckerLive),
  );
  try {
    // Additional-target replay uses its own explicit default session.
    const additionalState = new URL(`../.state/slot${additionalSlot}-qa.json`, import.meta.url).pathname;
    if (scenario === 'additional-target') {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(new URL('../.state', import.meta.url), { recursive: true });
      writeFileSync(additionalState, readFileSync(f.context.storageState));
    }
    let summary;
    try {
      summary = await runEffect(run);
    } finally {
      if (scenario === 'additional-target') rmSync(additionalState, { force: true });
    }
    assert.equal(summary.outcome, failed ? 'fail' : 'pass', JSON.stringify(summary));
    const reused = ['pass', 'product-failure', 'additional-target'].includes(scenario);
    assert.equal(summary.replays[0].provenance.kind, reused ? 'stabilization' : 'replay', JSON.stringify(summary));
    assert.equal(executions, ['pass', 'product-failure'].includes(scenario) ? 1 : 2);
    assert.ok(summary.replays[0].mp4Bytes > 0);
    if (scenario === 'additional-target') assert.equal(summary.replays[1].provenance.kind, 'replay');
    const result = {
      scenario,
      executions,
      avoidedExecutionMs: summary.replays[0].avoidedExecutionMs,
      finalEvidenceWallMs: summary.replays[0].wallMs,
      independentReplayExecutionMs: summary.replays.find((r: any) => r.provenance.kind === 'replay')?.executionMs,
      video: summary.replays[0].video,
      runDir: f.runDir,
    };
    measurements.push(result);
    console.log(JSON.stringify(result));
  } finally {
    await new Promise<void>((r, reject) => server.close((e) => (e ? reject(e) : r())));
    rmSync(spec.specDir, { recursive: true, force: true });
    f.close();
  }
}
console.log(JSON.stringify({ measurements }, null, 2));
