import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  attemptArtifacts,
  captureIdentity,
  hashFile,
  saveAttempt,
  type AttemptManifest,
  type EvidenceContext,
} from '../../src/attempt-evidence.ts';
import { readTestResult } from '../../src/test-results.ts';
const root = new URL('../..', import.meta.url).pathname;

export function evidenceFixture(keep = false) {
  const dir = mkdtempSync(join(tmpdir(), 'checker-evidence-'));
  const worktree = join(dir, 'app'),
    runDir = join(dir, basename(dir));
  mkdirSync(worktree);
  mkdirSync(join(runDir, 'explore'), { recursive: true });
  mkdirSync(join(runDir, 'codify/attempts/attempt.fixture'), { recursive: true });
  writeFileSync(join(worktree, 'app.html'), '<h1>Ready</h1>');
  execFileSync('git', ['init', '-q', worktree]);
  execFileSync('git', ['add', '.'], { cwd: worktree });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: worktree });
  const old = { slots: process.env.E2E_SLOTS_PATH, environments: process.env.E2E_ENVIRONMENTS_PATH };
  process.env.E2E_SLOTS_PATH = join(dir, 'slots.json');
  process.env.E2E_ENVIRONMENTS_PATH = join(dir, 'environments.json');
  const environment = {
    id: 'local',
    revision: 'environment-v1',
    name: 'Local',
    kind: 'worktree',
    devMode: 'ci.development',
    users: [{ id: 'qa', name: 'QA', usernameRef: 'env://QA_USERNAME', passwordRef: 'env://QA_PASSWORD' }],
  };
  writeFileSync(process.env.E2E_ENVIRONMENTS_PATH, JSON.stringify([environment]));
  writeFileSync(
    process.env.E2E_SLOTS_PATH,
    JSON.stringify({ fixture: { slot: 'fixture', worktree, port: 45678, pid: process.pid, role: 'qa' } }),
  );
  const context: EvidenceContext = {
    runDir,
    specPath: join(dir, 'case.spec.ts'),
    casePath: join(runDir, 'explore/case.json'),
    base: 'http://localhost:45678',
    slot: 'fixture',
    role: 'qa',
    storageState: join(dir, 'state.json'),
  };
  writeFileSync(context.specPath, "import { test } from '@playwright/test';\ntest('fixture', async () => {});\n");
  writeFileSync(
    context.casePath,
    JSON.stringify({ project: 'LOCAL', id: 1, revision: 'case-v1', steps: [{ action: 'Open', expected_result: 'Ready' }] }),
  );
  writeFileSync(context.storageState, JSON.stringify({ cookies: [], origins: [] }));
  const artifactDir = join(runDir, 'codify/attempts/attempt.fixture');
  const video = join(artifactDir, 'video.webm'),
    trace = join(artifactDir, 'trace.zip');
  writeFileSync(video, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]));
  writeFileSync(
    trace,
    Buffer.from(
      'UEsDBBQAAAAAAA1bWl0XyuPAGwAAABsAAAAKAAAAdGVzdC50cmFjZXsidHlwZSI6ImNvbnRleHQtb3B0aW9ucyJ9ClBLAQIUAxQAAAAAAA1bWl0XyuPAGwAAABsAAAAKAAAAAAAAAAAAAACAAQAAAAB0ZXN0LnRyYWNlUEsFBgAAAAABAAEAOAAAAEMAAAAAAA==',
      'base64',
    ),
  );
  writeFileSync(join(artifactDir, 'network.json'), JSON.stringify({ version: 1, requests: [] }));
  writeFileSync(artifactDir + '.log', 'fixture test execution');
  const build = (failed = false) => {
    writeFileSync(
      join(runDir, 'explore/report.json'),
      JSON.stringify({ verdict: failed ? 'fail' : 'pass', steps: [{ position: 1, verdict: failed ? 'fail' : 'pass' }] }),
    );
    const error = failed ? { message: 'Error: expect(received).toBe(expected) failed' } : undefined;
    const now = Date.now();
    const report = {
      config: { rootDir: dirname(context.specPath), configFile: resolve(root, 'e2e/playwright.config.ts') },
      suites: [
        {
          specs: [
            {
              file: basename(context.specPath),
              tests: [
                {
                  expectedStatus: 'passed',
                  results: [
                    {
                      status: failed ? 'failed' : 'passed',
                      duration: 100,
                      startTime: new Date(now - 900).toISOString(),
                      retry: 0,
                      error,
                      errors: error ? [error] : [],
                      steps: [{ title: 'Step 1: Open', error }],
                      attachments: [
                        { name: 'video', contentType: 'video/webm', path: video },
                        { name: 'trace', contentType: 'application/zip', path: trace },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      errors: [],
      stats: {
        startTime: new Date(now - 900).toISOString(),
        duration: 100,
        expected: failed ? 0 : 1,
        unexpected: failed ? 1 : 0,
        skipped: 0,
        flaky: 0,
      },
    };
    writeFileSync(join(artifactDir, 'results.json'), JSON.stringify(report));
    const identity = captureIdentity(context);
    assert.ok(
      identity.inputs && identity.case && identity.target && identity.environment && identity.user,
      'fixture identity must be established',
    );
    const manifest: AttemptManifest = {
      version: 1,
      attemptId: 'attempt.fixture',
      attempts: 1,
      runDir,
      specPath: context.specPath,
      artifactDir,
      manifestPath: artifactDir + '.manifest.json',
      state: 'completed',
      specHash: hashFile(context.specPath),
      identity,
      identityAfter: identity,
      startedAt: new Date(now - 1000).toISOString(),
      completedAt: new Date(now).toISOString(),
      executionMs: 1000,
      code: failed ? 1 : 0,
      result: readTestResult(artifactDir),
      artifacts: attemptArtifacts(artifactDir),
    };
    writeFileSync(join(runDir, 'codify/attempts.json'), JSON.stringify({ attempts: 1 }));
    saveAttempt(manifest);
    return {
      manifest,
      report,
      verified: {
        manifestPath: manifest.manifestPath,
        outcome: failed ? ('failed-as-expected' as const) : ('passed' as const),
        failingStep: failed ? 1 : null,
      },
    };
  };
  return {
    dir,
    worktree,
    runDir,
    context,
    artifactDir,
    video,
    trace,
    environment,
    build,
    close: () => {
      if (old.slots === undefined) delete process.env.E2E_SLOTS_PATH;
      else process.env.E2E_SLOTS_PATH = old.slots;
      if (old.environments === undefined) delete process.env.E2E_ENVIRONMENTS_PATH;
      else process.env.E2E_ENVIRONMENTS_PATH = old.environments;
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}
