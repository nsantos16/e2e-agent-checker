import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '../src/jobs.ts';
import { syncSessions, createSession, getSession, addSessionRuns, primarySessionId } from '../src/sessions.ts';
import { buildSessionSummary, generateSessionSummary } from '../src/session-summary.ts';
import { publishEvidence } from '../src/publication.ts';

const job = (id: string, changes: Partial<Job> = {}): Job => ({
  id,
  project: 'LOCAL',
  caseId: 1,
  worktree: '',
  role: 'qa',
  status: 'done',
  outcome: 'pass',
  createdAt: '2026-11-01T00:00:00Z',
  log: [],
  ...changes,
});
test('sessions use exact batch/replay IDs, persist explicit membership, retain removed members and summarize partial outcomes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-sessions-')),
    prev = process.env.E2E_STATE_DIR;
  process.env.E2E_STATE_DIR = dir;
  try {
    const jobs = [
      job('a', { batchId: 'batch-one' }),
      job('b', { batchId: 'batch-one', outcome: 'fail' }),
      job('same-time'),
      job('replayed', { replayOf: 'a' }),
      job('blocked', { outcome: 'blocked' }),
      job('cancelled', { status: 'cancelled' }),
      job('active', { status: 'running' }),
      job('codify', { outcome: 'codify-failed' }),
    ];
    syncSessions(jobs);
    assert.deepEqual(getSession('batch-one').jobIds, ['a', 'b', 'replayed']);
    assert.deepEqual(getSession('same-time').jobIds, ['same-time'], 'identical timestamps never imply membership');
    assert.equal(primarySessionId(jobs[3], jobs), 'batch-one');
    const session = createSession({ title: 'Feature <script> proof | demo', jobIds: jobs.map((j) => j.id) }, jobs);
    assert.deepEqual(getSession(session.id), session, 'read reloads the persisted record');
    assert.throws(() => addSessionRuns(session.id, { expectedRevision: 'stale', jobIds: ['a'] }, jobs), /membership changed/);
    assert.throws(() => createSession({ title: 'Unknown', jobIds: ['missing'] }, jobs), /not found/);
    const first = buildSessionSummary(session, jobs, 'http://localhost:4100');
    assert.deepEqual(first.counts, {
      pass: 3,
      fail: 1,
      blocked: 1,
      cancelled: 1,
      incomplete: 1,
      'codify-failed': 1,
    });
    assert.match(first.markdown, /&lt;script&gt;/);
    assert.match(first.markdown, /Failures, blocked and incomplete/);
    assert.match(first.markdown, /Build commit was not recorded/);
    assert.equal(first.revision, generateSessionSummary(session, jobs, 'http://localhost:4100').revision);
    syncSessions(jobs.filter((j) => j.id !== 'b'));
    assert.ok(getSession('batch-one').jobIds.includes('b'), 'hiding or removing a run cannot rewrite history');
    const incomplete = buildSessionSummary(
      session,
      jobs.filter((j) => j.id !== 'b'),
      'http://localhost:4100',
    );
    assert.equal(incomplete.counts.unavailable, 1);
    assert.notEqual(incomplete.revision, first.revision);
  } finally {
    if (prev === undefined) delete process.env.E2E_STATE_DIR;
    else process.env.E2E_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session summaries distinguish current failed replay from historical passes and retain expired results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-summary-'));
  try {
    writeFileSync(
      join(dir, 'verification.json'),
      JSON.stringify({
        verdict: 'fail',
        steps: [{ position: 1, verdict: 'fail', evidence: 'Current title missing' }],
      }),
    );
    const run = job('reused', {
      runDir: dir,
      outcome: 'fail',
      replay: { status: 'failed' },
      hiddenAt: '2026-11-01',
      historicalExploration: { sourceRun: '/historical', verdict: 'pass' },
      specSelection: {
        mode: 'reuse',
        reason: 'compatible',
        sourceRun: '/historical',
      },
      testedBuild: {
        capturedAt: '2026-11-01',
        baseUrl: 'https://fixture.test',
        buildId: 'release-42',
      },
    });
    const session = {
      id: 's',
      title: 'Current evidence',
      jobIds: [run.id],
      revision: '1',
      createdAt: '2026-11-01',
      source: 'explicit' as const,
    };
    const summary = buildSessionSummary(session, [run], 'http://localhost:4100');
    assert.equal(summary.runs[0].exploreVerdict, undefined);
    assert.equal(summary.runs[0].historicalExploration?.verdict, 'pass');
    assert.equal(summary.runs[0].stepEvidence, 'current verification');
    assert.match(summary.markdown, /Current title missing/);
    assert.match(summary.markdown, /release/);
    assert.doesNotMatch(summary.markdown, /Build commit was not recorded/);
    assert.deepEqual(summary.counts, { fail: 1 });
    rmSync(join(dir, 'verification.json'));
    const expired = buildSessionSummary(session, [{ ...run, cacheClearedAt: '2026-11-01' }], 'http://localhost:4100');
    assert.deepEqual(expired.counts, { fail: 1 });
    assert.match(expired.markdown, /artifacts expired under cache retention/);
    const removed = buildSessionSummary(session, [undefined], 'http://localhost:4100');
    assert.deepEqual(removed.counts, { unavailable: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session publication uses the standard format, attached links and exact deduplication; no real destination is called', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-publication-')),
    prev = process.env.E2E_STATE_DIR;
  process.env.E2E_STATE_DIR = dir;
  try {
    const video = join(dir, 'verification.mp4');
    writeFileSync(video, 'fixture video');
    mkdirSync(join(dir, 'explore'));
    writeFileSync(
      join(dir, 'explore/report.json'),
      JSON.stringify({
        verdict: 'fail',
        steps: [{ position: 1, verdict: 'fail', evidence: 'Expected title missing' }],
      }),
    );
    const j = job('run-a', {
      runDir: dir,
      video,
      outcome: 'fail',
      replay: { status: 'failed', failedStep: 'Heading' },
    });
    const session = createSession({ title: 'Review evidence', jobIds: [j.id] }, [j]);
    let posted = '',
      publishes = 0;
    const execute: NonNullable<Parameters<typeof publishEvidence>[4]> = async (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'api') return { code: 0, stdout: posted, stderr: '' };
      publishes++;
      posted = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      assert.match(posted, /Verification session/);
      assert.match(posted, /Expected title missing/);
      assert.match(posted, /\[Silent replay MP4\]\(\.\//);
      assert.doesNotMatch(posted, /localhost|127\.0\.0\.1|checker-publication/);
      assert.equal(readFileSync(args[args.indexOf('--attach') + 1], 'utf8'), 'fixture video');
      return {
        code: 0,
        stdout: 'https://github.com/test/example/pull/1#issuecomment-fixture',
        stderr: '',
      };
    };
    const input = {
      sessionId: session.id,
      pr: 'https://github.com/test/example/pull/1',
      publish: true,
    };
    const results = await Promise.all([
      publishEvidence(input, [j], session, undefined, execute),
      publishEvidence(input, [j], session, undefined, execute),
    ]);
    assert.equal(publishes, 1);
    assert.equal(results[1].alreadyPublished, true);
    await assert.rejects(publishEvidence({ ...input, publish: false }, [j], session, undefined, execute));
    await assert.rejects(publishEvidence({ ...input, video: 'narrated' }, [j], session, undefined, execute), /ready narrated demo/);
    await publishEvidence(input, [{ ...j, outcome: 'blocked' }], session, undefined, execute);
    assert.equal(publishes, 2, 'changed evidence gets a new exact content marker');
  } finally {
    if (prev === undefined) delete process.env.E2E_STATE_DIR;
    else process.env.E2E_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
