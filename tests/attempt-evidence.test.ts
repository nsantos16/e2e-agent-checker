import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { attemptArtifacts, qualifyAttempt, saveAttempt, type AttemptManifest } from '../src/attempt-evidence.ts';
import { readCompletedTestResult } from '../src/test-results.ts';
import { replayEffect } from '../src/replay.ts';
import { ProcessRunner } from '../src/process.ts';
import { runEffect } from '../src/runtime/effect.ts';
import { stageTools } from '../src/stage-tools.ts';

import { evidenceFixture } from './fixtures/evidence.ts';

test('eligible passes and verified product failures retain actual result and artifacts', () => {
  const f = evidenceFixture();
  try {
    for (const failed of [false, true]) {
      const { verified } = f.build(failed);
      const eligible = qualifyAttempt(f.context, verified);
      assert.equal(eligible.eligible, true, JSON.stringify(eligible));
      if (eligible.eligible) {
        assert.equal(eligible.result.status, failed ? 'failed' : 'passed');
        assert.equal(eligible.video, f.video);
        assert.equal(eligible.trace, f.trace);
        if (failed) assert.equal(eligible.result.failedStep, 'Step 1: Open');
      }
    }
  } finally {
    f.close();
  }
});

test('eligibility rejects changed inputs, unknown builds, missing artifacts, stale and cancelled attempts', async (t) => {
  const cases: [string, (f: ReturnType<typeof evidenceFixture>, m: AttemptManifest) => void][] = [
    [
      'config identity',
      (_f, m) => {
        const inputs = m.identity!.inputs!;
        const config = Object.keys(inputs.files).find((path) => path.endsWith('/e2e/playwright.config.ts'));
        assert.ok(config, 'Playwright config must be fingerprinted');
        inputs.files[config] = 'previous-config-hash';
        saveAttempt(m);
      },
    ],
    ['spec', (f) => writeFileSync(f.context.specPath, '// changed')],
    [
      'helper',
      (f) => {
        writeFileSync(join(f.dir, 'helper.ts'), 'export const value = 1;');
        writeFileSync(f.context.specPath, "import './helper.ts';");
      },
    ],
    ['source build', (f) => writeFileSync(join(f.worktree, 'app.html'), '<h1>Changed</h1>')],
    ['untracked build input', (f) => writeFileSync(join(f.worktree, 'new.ts'), 'export const value = 1;')],
    ['ignored build env', (f) => writeFileSync(join(f.worktree, '.env.ci.development.local'), 'FLAG=changed')],
    ['case revision', (f) => writeFileSync(f.context.casePath, JSON.stringify({ project: 'LOCAL', id: 1, revision: 'v2' }))],
    ['session', (f) => writeFileSync(f.context.storageState, JSON.stringify({ cookies: [{ name: 'changed' }] }))],
    ['environment', (f) => writeFileSync(process.env.E2E_ENVIRONMENTS_PATH!, JSON.stringify([{ ...f.environment, revision: 'v2' }]))],
    [
      'user',
      (f) => {
        f.context.role = 'other';
      },
    ],
    [
      'target',
      (f) => {
        f.context.base = 'http://localhost:45679';
      },
    ],
    ['unknown build', () => writeFileSync(process.env.E2E_SLOTS_PATH!, '{}')],
    ['video', (f) => rmSync(f.video)],
    [
      'malformed trace',
      (f, m) => {
        writeFileSync(f.trace, 'PKtruncated');
        m.artifacts = attemptArtifacts(f.artifactDir);
        saveAttempt(m);
      },
    ],
    [
      'malformed diagnostics',
      (f, m) => {
        writeFileSync(join(f.artifactDir, 'network.json'), '{}');
        m.artifacts = attemptArtifacts(f.artifactDir);
        saveAttempt(m);
      },
    ],
    [
      'changed selected environment revision',
      (f) => {
        f.context.environmentRevision = 'old-revision';
      },
    ],
    [
      'changed selected user identity',
      (f) => {
        f.context.userIdentity = 'old-identity';
      },
    ],
    ['trace', (f) => rmSync(f.trace)],
    ['network', (f) => rmSync(join(f.artifactDir, 'network.json'))],
    ['modified results', (f) => writeFileSync(join(f.artifactDir, 'results.json'), '{}')],
    ['malformed manifest', (_f, m) => writeFileSync(m.manifestPath, '{')],
    [
      'old format',
      (_f, m) => {
        (m as any).version = 0;
        saveAttempt(m);
      },
    ],
    [
      'cancelled',
      (_f, m) => {
        m.state = 'cancelled';
        saveAttempt(m);
      },
    ],
    [
      'partial',
      (_f, m) => {
        m.state = 'running';
        saveAttempt(m);
      },
    ],
    ['newer attempt', (f) => writeFileSync(join(f.runDir, 'codify/attempts.json'), '{"attempts":2}')],
    [
      'stale',
      (_f, m) => {
        m.startedAt = new Date(Date.now() - 3_601_000).toISOString();
        m.completedAt = new Date(Date.now() - 3_600_000).toISOString();
        saveAttempt(m);
      },
    ],
    [
      'changed during execution',
      (_f, m) => {
        m.identityAfter = { ...m.identity!, specHash: 'changed' };
        saveAttempt(m);
      },
    ],
    [
      'wrong exit',
      (_f, m) => {
        m.code = 1;
        saveAttempt(m);
      },
    ],
    [
      'malformed recording',
      (f, m) => {
        writeFileSync(f.video, 'not a video');
        m.artifacts = attemptArtifacts(f.artifactDir);
        saveAttempt(m);
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, () => {
      const f = evidenceFixture();
      try {
        const { manifest, verified } = f.build();
        mutate(f, manifest);
        assert.equal(qualifyAttempt(f.context, verified).eligible, false);
      } finally {
        f.close();
      }
    });
});

test('completed results reject malformed, partial, skipped, retried, interrupted and runner failures', async (t) => {
  const cases: [string, (r: any) => void][] = [
    [
      'malformed suites',
      (r) => {
        r.suites = {};
      },
    ],
    [
      'second empty test',
      (r) => {
        r.suites[0].specs[0].tests.push({ results: [] });
      },
    ],
    [
      'retry',
      (r) => {
        r.suites[0].specs[0].tests[0].results[0].retry = 1;
      },
    ],
    [
      'skipped',
      (r) => {
        r.suites[0].specs[0].tests[0].results[0].status = 'skipped';
      },
    ],
    [
      'interrupted',
      (r) => {
        r.suites[0].specs[0].tests[0].results[0].status = 'interrupted';
      },
    ],
    [
      'timed out',
      (r) => {
        r.suites[0].specs[0].tests[0].results[0].status = 'timedOut';
      },
    ],
    [
      'runner error',
      (r) => {
        r.errors = [{ message: 'worker crashed' }];
      },
    ],
    [
      'no final stats',
      (r) => {
        delete r.stats;
      },
    ],
    [
      'expected failure annotation',
      (r) => {
        r.suites[0].specs[0].tests[0].expectedStatus = 'failed';
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, () => {
      const f = evidenceFixture();
      try {
        const { report } = f.build();
        mutate(report);
        writeFileSync(join(f.artifactDir, 'results.json'), JSON.stringify(report));
        assert.equal(readCompletedTestResult(f.artifactDir, 0), undefined);
      } finally {
        f.close();
      }
    });
});

test('missing recording falls back to execution; corrupt video conversion also falls back', async () => {
  for (const missing of [true, false]) {
    const f = evidenceFixture();
    try {
      const { verified } = f.build();
      if (missing) rmSync(f.video);
      const calls: string[] = [];
      const result = await runEffect(
        replayEffect({
          runDir: f.runDir,
          label: 'fixture',
          specDir: f.dir,
          specFile: 'case.spec.ts',
          base: f.context.base,
          slot: 'fixture',
          role: 'qa',
          storageState: f.context.storageState,
          evidenceContext: f.context,
          reuseAttempt: verified,
        }).pipe(
          Effect.provideService(ProcessRunner, {
            execute: (name) =>
              Effect.sync(() => {
                calls.push(name);
                return { code: name === 'npx' ? 0 : 1, stdout: 'fallback', stderr: '' };
              }),
          }),
        ),
      );
      assert.equal(result.provenance.kind, 'replay');
      assert.equal(result.avoidedExecutionMs, 0);
      assert.deepEqual(calls, missing ? ['npx'] : ['ffmpeg', 'npx']);
    } finally {
      f.close();
    }
  }
});

for (const scope of ['stage', 'request'] as const)
  test(`${scope} cancellation marks the exact attempt unusable even when a process writes a result`, async () => {
    const f = evidenceFixture(),
      oldPath = process.env.PATH;
    const controller = new AbortController();
    const marker = join(f.dir, 'started');
    writeFileSync(
      join(f.dir, 'npx'),
      `#!/usr/bin/env node\nconst fs=require('node:fs');fs.copyFileSync(${JSON.stringify(join(f.artifactDir, 'results.json'))},process.env.E2E_OUTPUT_DIR+'/results.json');fs.writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`,
      { mode: 0o755 },
    );
    process.env.PATH = f.dir + ':' + oldPath;
    const service = await stageTools(
      {
        specPath: f.context.specPath,
        runDir: f.runDir,
        evidenceContext: f.context,
      },
      scope === 'stage' ? controller.signal : undefined,
    );
    try {
      f.build();
      const attempt = service.call('try_spec', {}, scope === 'request' ? controller.signal : undefined);
      const settled =
        scope === 'stage'
          ? assert.rejects(attempt, /cancelled/)
          : attempt.then((result) => {
              assert.equal(result.isError, true);
              assert.match(result.content[0].text, /cancelled/);
            });
      for (let i = 0; i < 300; i++) {
        try {
          readFileSync(marker);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      assert.equal(readFileSync(marker, 'utf8'), 'started');
      controller.abort(new Error('cancelled'));
      await settled;
      const last: AttemptManifest = JSON.parse(readFileSync(join(f.runDir, 'codify/last-attempt.json'), 'utf8'));
      assert.equal(last.state, 'cancelled');
      assert.equal(last.result?.status, 'passed');
      assert.equal(last.code, null);
      assert.equal(
        qualifyAttempt(f.context, {
          manifestPath: last.manifestPath,
          outcome: 'passed',
          failingStep: null,
        }).eligible,
        false,
      );
      if (scope === 'request') assert.equal((await service.call('qa_network_requests', {})).isError, false);
    } finally {
      await service.close();
      process.env.PATH = oldPath;
      f.close();
    }
  });

test('transitive helper contents and spec environment inputs must still match', () => {
  const f = evidenceFixture();
  const old = process.env.CHECKER_FIXTURE_FLAG;
  try {
    const helper = join(f.dir, 'helper.ts');
    writeFileSync(helper, 'export const value = 1;');
    writeFileSync(f.context.specPath, "import { value } from './helper';\nconst flag = process.env.CHECKER_FIXTURE_FLAG;\n");
    const { verified } = f.build();
    assert.equal(qualifyAttempt(f.context, verified).eligible, true);
    writeFileSync(helper, 'export const value = 2;');
    assert.equal(qualifyAttempt(f.context, verified).eligible, false);
    writeFileSync(helper, 'export const value = 1;');
    process.env.CHECKER_FIXTURE_FLAG = 'changed';
    assert.equal(qualifyAttempt(f.context, verified).eligible, false);
  } finally {
    if (old === undefined) delete process.env.CHECKER_FIXTURE_FLAG;
    else process.env.CHECKER_FIXTURE_FLAG = old;
    f.close();
  }
});

test('promotion packages the manifest video without another test and retains failure diagnostics', async () => {
  for (const failed of [false, true]) {
    const f = evidenceFixture();
    try {
      const { verified } = f.build(failed);
      const calls: string[] = [];
      const result = await runEffect(
        replayEffect({
          runDir: f.runDir,
          label: 'fixture',
          specDir: f.dir,
          specFile: 'case.spec.ts',
          base: f.context.base,
          slot: 'fixture',
          role: 'qa',
          storageState: f.context.storageState,
          evidenceContext: f.context,
          reuseAttempt: verified,
        }).pipe(
          Effect.provideService(ProcessRunner, {
            execute: (name, args) =>
              Effect.sync(() => {
                calls.push(name);
                assert.equal(args[args.indexOf('-i') + 1], f.video);
                writeFileSync(args.at(-1)!, 'converted video');
                return { code: 0, stdout: '', stderr: '' };
              }),
          }),
        ),
      );
      assert.deepEqual(calls, ['ffmpeg']);
      assert.equal(result.status, failed ? 'failed' : 'passed');
      assert.equal(result.executionMs, 0);
      assert.equal(result.avoidedExecutionMs, 1000);
      assert.equal(result.provenance.kind, 'stabilization');
      assert.equal(result.provenance.independentRun, false);
      assert.equal(result.trace, f.trace);
      assert.equal(result.results, join(f.artifactDir, 'results.json'));
      assert.match(result.log, /fixture test execution/);
      if (failed) {
        assert.equal(result.failedStep, 'Step 1: Open');
        assert.match(result.error!, /expect/);
      }
    } finally {
      f.close();
    }
  }
});

test('a different failed step or an authoring error cannot promote as a verified product failure', () => {
  const f = evidenceFixture();
  try {
    const { manifest, report, verified } = f.build(true);
    assert.equal(qualifyAttempt(f.context, { ...verified, failingStep: 2 }).eligible, false);
    report.suites[0].specs[0].tests[0].results[0].error = { message: 'page.click: locator timed out' };
    writeFileSync(join(f.artifactDir, 'results.json'), JSON.stringify(report));
    manifest.result = readCompletedTestResult(f.artifactDir, 1)?.result;
    manifest.artifacts = attemptArtifacts(f.artifactDir);
    saveAttempt(manifest);
    assert.equal(qualifyAttempt(f.context, verified).eligible, false);
  } finally {
    f.close();
  }
});
