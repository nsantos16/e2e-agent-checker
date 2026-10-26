import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { CaseCatalog, caseCompatibility } from '../src/cases.ts';
import type { Environment } from '../src/environments.ts';
import {
  captureBuild,
  compatibilityContext,
  compatibilityReason,
  publishSavedSpec,
  readSavedSpec,
  selectSavedSpec,
  specRequirements,
  specPortabilityReason,
} from '../src/saved-specs.ts';
import { verifyEffect, type VerifyOptions } from '../src/verify.ts';
import { specLocation } from '../src/codify.ts';
import { replayEffect } from '../src/replay.ts';
import { runEffect } from '../src/runtime/effect.ts';
import { CheckerLive } from '../src/runtime/services.ts';
import { ProviderRegistry } from '../src/providers/index.ts';
import { PricingCatalog } from '../src/pricing.ts';
import { ProcessRunner } from '../src/process.ts';
import { artifactPath, jobSummary, readEvidence } from '../src/agent-view.ts';
import type { Job } from '../src/jobs.ts';

const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const source = `import {test,expect} from '@playwright/test';
import {qaseStep} from '../../qase-step';
test('fixture', async({page}) => { await qaseStep(page, 1, 'Ready', async() => {
  await page.goto('/'); await expect(page.locator('h1')).toHaveText('Ready');
}); });`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'saved-spec-test-'));
  const catalog = new CaseCatalog(join(dir, 'cases.json'), join(dir, 'fixtures'));
  const testCase = catalog.create({ title: 'Ready', status: 'active', steps: [{ action: 'Open page', expected_result: 'Ready' }] });
  const environment: Environment = {
    id: 'fixture',
    name: 'Fixture',
    revision: 'env-1',
    kind: 'hosted',
    baseUrl: 'http://fixture.test',
    devMode: 'test',
    users: [{ id: 'qa', name: 'QA', usernameRef: 'env://FIXTURE_USER', passwordRef: 'env://FIXTURE_PASSWORD' }],
  };
  const state = join(dir, 'state.json');
  json(state, { cookies: [], origins: [] });
  const context = compatibilityContext(testCase, specRequirements(environment, environment.users[0], environment.baseUrl!));
  const oldRuns = process.env.E2E_RUNS_DIR;
  process.env.E2E_RUNS_DIR = dir;
  const options = (name: string): VerifyOptions => ({
    project: testCase.project,
    caseId: testCase.id,
    caseSnapshot: testCase,
    environment,
    slot: 'fixture',
    role: 'qa',
    base: environment.baseUrl,
    storageState: state,
    model: 'fixture',
    target: { provider: 'claude-code', model: 'fixture', authMode: 'subscription' },
    runDir: join(dir, name),
  });
  const seed = (name = 'source') => {
    const runDir = join(dir, name);
    mkdirSync(join(runDir, 'codify'), { recursive: true });
    mkdirSync(join(runDir, 'explore'), { recursive: true });
    writeFileSync(join(runDir, 'codify/LOCAL-1.spec.ts'), source);
    json(join(runDir, 'explore/case.json'), testCase);
    json(join(runDir, 'explore/report.json'), {
      caseId: 1,
      verdict: 'pass',
      steps: [{ position: 1, verdict: 'pass', evidence: 'OLD observation' }],
    });
    const manifest = publishSavedSpec(runDir, context, captureBuild(environment.baseUrl!, undefined, 'old-build'));
    return { runDir, manifest };
  };
  const clean = () => {
    for (const name of ['source', 'fresh', 'reuse', 'failure', 'fallback', 'legacy', 'cancel', 'forced', 'changed'])
      rmSync(specLocation(join(dir, name), 'LOCAL', 1).specDir, { recursive: true, force: true });
    if (oldRuns === undefined) delete process.env.E2E_RUNS_DIR;
    else process.env.E2E_RUNS_DIR = oldRuns;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, testCase, catalog, environment, state, context, options, seed, clean };
}

test('versioned compatibility covers case, integrity, runtime and requirements but not tested build', () => {
  const f = fixture();
  try {
    const { runDir, manifest } = f.seed();
    assert.equal(compatibilityReason(manifest, f.context), undefined);
    assert.equal(selectSavedSpec(f.context).decision.mode, 'reuse');
    assert.equal(specPortabilityReason(source), undefined);
    assert.equal(specPortabilityReason("import { extra } from './missing-helper';"), 'spec-dependency-unsupported');
    assert.equal(specPortabilityReason("import './setup';"), 'spec-dependency-unsupported');
    assert.equal(specPortabilityReason("const helper = await import('./helper');"), 'spec-dependency-unsupported');
    assert.equal(specPortabilityReason("await page.goto('https://old-target.test/path');"), 'spec-target-not-portable');
    assert.equal(
      compatibilityReason({ ...manifest, testedBuild: captureBuild('http://new-build.test', '/other', 'next') }, f.context),
      undefined,
    );
    for (const changed of [
      { ...f.testCase, revision: 'new-revision' },
      { ...f.testCase, steps: [{ ...f.testCase.steps[0], expected_result: 'Different result' }] },
      { ...f.testCase, project: 'OTHER' },
      { ...f.testCase, id: 2 },
    ])
      assert.equal(compatibilityReason(manifest, { ...f.context, case: caseCompatibility(changed) }), 'case-changed');
    for (const runtime of [
      { ...f.context.runtime, nodeMajor: '999' },
      { ...f.context.runtime, playwright: 'changed' },
      { ...f.context.runtime, files: { ...f.context.runtime.files, 'e2e/qase-step.ts': '0'.repeat(64) } },
      { ...f.context.runtime, browserSha256: '0'.repeat(64) },
    ])
      assert.equal(compatibilityReason(manifest, { ...f.context, runtime }), 'runtime-changed');
    for (const requirements of [
      { ...f.context.requirements, revision: 'new-env' },
      { ...f.context.requirements, userId: 'other' },
      { ...f.context.requirements, origin: 'http://other.test' },
      specRequirements(f.environment, { ...f.environment.users[0], passwordRef: 'env://OTHER_PASSWORD' }, f.environment.baseUrl!),
    ])
      assert.equal(compatibilityReason(manifest, { ...f.context, requirements }), 'requirements-changed');
    const manifestPath = join(runDir, 'codify/manifest.json');
    json(manifestPath, { ...manifest, version: 99 });
    assert.equal(readSavedSpec(runDir, f.context), 'manifest-version-unsupported');
    writeFileSync(manifestPath, '{bad');
    assert.equal(readSavedSpec(runDir, f.context), 'manifest-corrupt');
    json(manifestPath, manifest);
    for (const path of ['codify/LOCAL-1.spec.ts', 'explore/case.json', 'explore/report.json']) {
      const full = join(runDir, path),
        bytes = readFileSync(full);
      rmSync(full);
      assert.equal(readSavedSpec(runDir, f.context), 'artifact-missing', path);
      writeFileSync(full, 'corrupt');
      assert.equal(readSavedSpec(runDir, f.context), 'artifact-integrity-mismatch', path);
      writeFileSync(full, bytes);
    }
    rmSync(manifestPath);
    assert.equal(selectSavedSpec(f.context).decision.reason, 'manifest-missing');
    assert.equal(selectSavedSpec(f.context, { forceFresh: true }).decision.reason, 'force-fresh');
    rmSync(runDir, { recursive: true });
    assert.equal(selectSavedSpec(f.context).decision.reason, 'no-saved-spec');
  } finally {
    f.clean();
  }
});

test('worktrees of the same repository and new commits remain compatible; a different app does not', () => {
  const f = fixture();
  const repo = join(f.dir, 'repo'),
    next = join(f.dir, 'next');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    mkdirSync(repo);
    git('init');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Fixture');
    writeFileSync(join(repo, 'app.txt'), 'old');
    git('add', '.');
    git('commit', '-m', 'Initial fixture');
    git('worktree', 'add', '-b', 'next', next);
    writeFileSync(join(repo, 'app.txt'), 'new');
    git('commit', '-am', 'Changed fixture');
    const env = { ...f.environment, kind: 'worktree' as const, baseUrl: undefined };
    const a = specRequirements(env, env.users[0], 'http://localhost:4001', repo);
    const b = specRequirements(env, env.users[0], 'http://localhost:4002', next);
    assert.deepEqual(a, b);
    assert.notEqual(captureBuild('http://localhost:4001', repo).commit, captureBuild('http://localhost:4002', next).commit);
    assert.notEqual(a.application, specRequirements(env, env.users[0], 'http://localhost:4003', f.dir).application);
  } finally {
    f.clean();
  }
});

test('candidate search skips damaged newest artifacts, validates bytes once, and does not require old videos', () => {
  const f = fixture();
  try {
    const good = f.seed('a-good');
    cpSync(good.runDir, join(f.dir, 'z-bad'), { recursive: true });
    rmSync(join(f.dir, 'z-bad/explore/report.json'));
    const picked = selectSavedSpec(f.context);
    assert.equal(picked.saved?.runDir, good.runDir);
    assert.equal(picked.decision.rejected?.[0].reason, 'artifact-missing');
    writeFileSync(join(good.runDir, 'codify/LOCAL-1.spec.ts'), 'changed after selection');
    assert.equal(picked.saved?.spec.toString(), source);
  } finally {
    f.clean();
  }
});

function execution(f: ReturnType<typeof fixture>, allowModels: boolean, failed = false) {
  const calls = { models: 0, preflights: 0, pricing: 0, replays: 0 };
  const execute = (options: VerifyOptions) =>
    runEffect(
      verifyEffect(options).pipe(
        Effect.provideService(ProviderRegistry, {
          inspect: (id) =>
            Effect.sync(() => {
              calls.preflights++;
              assert.ok(allowModels, 'reuse must not preflight a provider');
              return {
                id,
                name: 'Fixture',
                installed: true,
                auth: 'subscription' as const,
                ready: true,
                loginCommand: '',
                models: [{ id: 'fixture', name: 'Fixture' }],
              };
            }),
        }),
        Effect.provideService(PricingCatalog, {
          load: Effect.sync(() => {
            calls.pricing++;
            assert.ok(allowModels, 'reuse must not load model pricing');
            return { catalog: {}, source: 'cache' as const };
          }),
        }),
        Effect.provideService(ProcessRunner, {
          execute: (name, _args, opts = {}) =>
            Effect.sync(() => {
              if (name === 'claude') {
                assert.ok(allowModels, 'reuse must not call a model');
                calls.models++;
                const stage = JSON.parse(readFileSync(join(opts.cwd!, 'stage-config.json'), 'utf8'));
                let result;
                if (stage.specPath) {
                  writeFileSync(stage.specPath, source);
                  json(join(stage.runDir, 'codify/attempts.json'), { attempts: 1 });
                  json(join(stage.runDir, 'codify/last-attempt.json'), { specHash: digest(source), code: 0, result: { status: 'passed' } });
                  result = { specPath: stage.specPath, attempts: 1, outcome: 'passed', failingStep: null };
                } else result = { caseId: 1, verdict: 'pass', steps: [{ position: 1, verdict: 'pass', evidence: 'OLD observation' }] };
                opts.onLine?.(
                  JSON.stringify({
                    type: 'result',
                    result: JSON.stringify(result),
                    usage: { input_tokens: 100, output_tokens: 10 },
                    num_turns: 1,
                  }),
                );
              } else {
                assert.equal(name, 'npx');
                calls.replays++;
                assert.equal(opts.env?.E2E_BASE_URL, options.base);
                assert.equal(opts.env?.E2E_STORAGE_STATE, options.storageState);
                assert.equal(readFileSync(join(opts.env!.E2E_SPEC_DIR!, 'LOCAL-1.spec.ts'), 'utf8'), source);
                json(join(opts.env!.E2E_OUTPUT_DIR!, 'results.json'), {
                  suites: [
                    {
                      specs: [
                        {
                          tests: [
                            {
                              results: [
                                {
                                  status: failed ? 'failed' : 'passed',
                                  duration: 12,
                                  steps: [{ title: 'Step 1: Ready', ...(failed ? { error: { message: 'CURRENT regression' } } : {}) }],
                                  ...(failed ? { error: { message: 'CURRENT regression' } } : {}),
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                });
              }
              return { code: name === 'npx' && failed ? 1 : 0, stdout: '', stderr: '' };
            }),
        }),
        Effect.provide(CheckerLive),
      ),
    );
  return { calls, execute };
}

test('fresh authoring publishes a manifest; new build reuse bypasses models/preflight/pricing and preserves failures', async (t) => {
  const f = fixture();
  try {
    const fresh = execution(f, true);
    const original = await fresh.execute({ ...f.options('fresh'), buildId: 'build-1' });
    assert.equal(original.specSelection.reason, 'no-saved-spec');
    assert.equal(original.outcome, 'pass');
    assert.equal(fresh.calls.models, 2);
    assert.ok(existsSync(join(f.dir, 'fresh/codify/manifest.json')));
    const reused = execution(f, false, true);
    const result = await reused.execute({
      ...f.options('failure'),
      buildId: 'build-2',
      target: { provider: 'cursor', model: 'offline', authMode: 'subscription' },
    });
    assert.equal(result.specSelection.mode, 'reuse');
    assert.equal(result.outcome, 'fail');
    assert.equal(result.replays[0].provenance.kind, 'replay');
    assert.equal(result.replays[0].provenance.independentRun, true);
    assert.equal(result.testedBuild.buildId, 'build-2');
    assert.equal(result.authoredBuild.buildId, 'build-1');
    assert.deepEqual(reused.calls, { models: 0, preflights: 0, pricing: 0, replays: 1 });
    assert.equal(result.usage.totalTokens, 0);
    assert.equal(result.usage.billedCostUsd, null);
    assert.match(readFileSync(join(f.dir, 'failure/verification.json'), 'utf8'), /CURRENT regression/);
    assert.doesNotMatch(readFileSync(join(f.dir, 'failure/pr-comment.md'), 'utf8'), /OLD observation/);
    assert.equal(existsSync(join(f.dir, 'failure/explore/report.json')), false);
    assert.equal(existsSync(join(f.dir, 'failure/explore/metrics.json')), false);
    assert.equal(existsSync(join(f.dir, 'failure/pricing.json')), false);
    const job: Job = {
      id: 'failure',
      project: 'LOCAL',
      caseId: 1,
      role: 'qa',
      worktree: '',
      status: 'done',
      createdAt: '',
      log: [],
      runDir: join(f.dir, 'failure'),
      outcome: result.outcome,
      replay: result.replays[0],
      specSelection: result.specSelection,
      historicalExploration: result.historicalExploration,
    };
    const evidence = readEvidence(job, '');
    assert.equal(evidence.verdict, 'fail');
    assert.match(evidence.failedSteps![0].evidence!, /CURRENT regression/);
    assert.equal(evidence.artifacts!.find((a) => a.id === 'historical-report')?.historical, true);
    assert.equal(JSON.parse(readEvidence(job, '', { artifact: 'historical-report' }).text!).provenance.historical, true);
    assert.equal(jobSummary(job, '').specSelection?.mode, 'reuse');
    assert.equal(artifactPath(job, 'report'), realpathSync(join(f.dir, 'failure/verification.json')));
    const again = await reused.execute({ ...f.options('reuse'), confirmationReplay: true });
    assert.equal(again.outcome, 'fail', 'a failed reuse never replaces or weakens the original assertions');
    assert.equal(reused.calls.models, 0);
    await assert.rejects(reused.execute(f.options('reuse')), /RUN_DIR_EXISTS/);
    t.diagnostic(
      `Controlled pipeline measurement: model stage calls ${fresh.calls.models} -> 0; provider preflights ${fresh.calls.preflights} -> 0; pricing loads ${fresh.calls.pricing} -> 0. Replay still executes once per run. No live model latency/cost estimate.`,
    );
  } finally {
    f.clean();
  }
});

test('forceFresh, changed cases and missing artifacts author again with persisted reasons', async () => {
  const f = fixture();
  try {
    const { runDir } = f.seed();
    const forced = execution(f, true);
    assert.equal((await forced.execute({ ...f.options('forced'), forceFresh: true })).specSelection.reason, 'force-fresh');
    assert.equal(forced.calls.models, 2);
    const changed = f.catalog.update('LOCAL', 1, { expectedRevision: f.testCase.revision, changes: { title: 'Revised' } });
    const authored = await execution(f, true).execute({ ...f.options('changed'), caseSnapshot: changed });
    assert.equal(authored.specSelection.reason, 'case-changed');
    rmSync(join(f.dir, 'forced'), { recursive: true });
    rmSync(join(f.dir, 'changed'), { recursive: true });
    rmSync(join(runDir, 'codify/LOCAL-1.spec.ts'));
    // Real run names retain the case identity even when the spec has disappeared.
    const missing = join(f.dir, '9999-LOCAL-1-slotfixture');
    cpSync(runDir, missing, { recursive: true });
    const fallback = await execution(f, true).execute(f.options('fallback'));
    assert.equal(fallback.specSelection.reason, 'artifact-missing');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'fallback/summary.json'), 'utf8')).specSelection.reason, 'artifact-missing');
  } finally {
    f.clean();
  }
});

test('explicit replay still reads legacy artifacts without a manifest and labels their exploration historical', async () => {
  const f = fixture();
  try {
    const { runDir } = f.seed();
    rmSync(join(runDir, 'codify/manifest.json'));
    const replay = execution(f, false);
    const result = await replay.execute({ ...f.options('legacy'), replayOnly: true, fromRun: runDir });
    assert.equal(result.specSelection.mode, 'replay');
    assert.equal(result.outcome, 'pass');
    assert.equal(result.historicalExploration.sourceRun, runDir);
    assert.equal(replay.calls.preflights, 0);
  } finally {
    f.clean();
  }
});

test('reuse cancellation preserves zero usage and never starts authoring', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel reuse'), { code: 'CANCELLED' });
  try {
    f.seed();
    await assert.rejects(
      runEffect(
        verifyEffect({ ...f.options('cancel'), signal: controller.signal }).pipe(
          Effect.provideService(ProcessRunner, {
            execute: () =>
              Effect.gen(function* () {
                controller.abort(reason);
                yield* Effect.never;
                return { code: 0, stdout: '', stderr: '' };
              }),
          }),
          Effect.provideService(ProviderRegistry, { inspect: () => Effect.die('must not preflight') }),
          Effect.provideService(PricingCatalog, { load: Effect.die('must not load pricing') }),
          Effect.provide(CheckerLive),
        ),
        controller.signal,
      ),
      (e) => e === reason,
    );
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'cancel/usage.json'), 'utf8')).usage.totalTokens, 0);
    assert.equal(existsSync(join(f.dir, 'cancel/codify/manifest.json')), false);
  } finally {
    f.clean();
  }
});

test('replay refuses stale output and packaging errors cannot hide an assertion failure', async () => {
  const f = fixture();
  try {
    f.seed();
    const runDir = join(f.dir, 'failure');
    const result = await runEffect(
      verifyEffect(f.options('failure')).pipe(
        Effect.provideService(ProviderRegistry, { inspect: () => Effect.die('must not preflight') }),
        Effect.provideService(PricingCatalog, { load: Effect.die('must not load pricing') }),
        Effect.provideService(ProcessRunner, {
          execute: (name, _args, opts = {}) =>
            Effect.sync(() => {
              if (name === 'npx') {
                writeFileSync(join(opts.env!.E2E_OUTPUT_DIR!, 'video.webm'), 'fixture video');
                json(join(opts.env!.E2E_OUTPUT_DIR!, 'results.json'), {
                  suites: [
                    {
                      specs: [
                        {
                          tests: [
                            {
                              results: [
                                {
                                  status: 'failed',
                                  duration: 1,
                                  error: { message: 'Assertion failed' },
                                  steps: [{ title: 'Step 1: Ready', error: { message: 'Assertion failed' } }],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                });
              } else assert.equal(name, 'ffmpeg');
              return { code: 1, stdout: '', stderr: 'fixture failure' };
            }),
        }),
        Effect.provide(CheckerLive),
      ),
    );
    assert.equal(result.outcome, 'fail');
    assert.match(result.replays[0].packagingError, /Video conversion failed/);
    assert.equal(result.replays[0].video, undefined);
    assert.match(result.verification.steps[0].evidence, /Assertion failed/);
    await assert.rejects(
      runEffect(
        replayEffect({
          runDir,
          label: 'slotfixture',
          ...specLocation(runDir, 'LOCAL', 1),
          base: f.environment.baseUrl!,
          role: 'qa',
          slot: 'fixture',
        }).pipe(Effect.provideService(ProcessRunner, { execute: () => Effect.die('must not execute with stale output') })),
      ),
      /EEXIST/,
    );
  } finally {
    f.clean();
  }
});
