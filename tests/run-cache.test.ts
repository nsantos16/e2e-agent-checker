import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanRunCaches } from '../src/run-cache.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Job } from '../src/jobs.ts';

const now = Date.parse('2026-11-01T12:00:00Z');
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'checker-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roots = { runs: join(dir, 'runs'), generated: join(dir, 'generated') };
  mkdirSync(roots.runs);
  mkdirSync(roots.generated);
  const file = (path: string) => {
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    writeFileSync(path, 'evidence');
  };
  const job = (id: string, overrides: Partial<Job> = {}): Job => {
    const runDir = join(roots.runs, id);
    for (const path of [
      'explore/case.json',
      'explore/report.json',
      'explore/video/raw.webm',
      'explore/transcript.jsonl',
      'codify/LOCAL-1.spec.ts',
      'replay-1/verification.mp4',
      'replay-1/trace.zip',
      'live/frame.jpg',
    ])
      file(join(runDir, path));
    file(join(roots.generated, id, 'LOCAL-1.spec.ts'));
    return {
      id,
      project: 'LOCAL',
      caseId: 1,
      worktree: '',
      role: 'test',
      status: 'done',
      createdAt: '2026-10-01T00:00:00Z',
      finishedAt: '2026-10-01T00:10:00Z',
      log: [],
      runDir,
      ...overrides,
    };
  };
  return { dir, roots, job, file };
}
test('retention settings start off, validate days, reject stale writes and persist', (t) => {
  const { dir } = setup(t),
    store = new SettingsStore(join(dir, 'settings.json'));
  assert.equal(store.get().runCacheAfterDays, null);
  for (const days of [0, -1, 1.5, 3651])
    assert.throws(() => store.save({ expectedRevision: 'initial', settings: { runCacheAfterDays: days } }));
  const settings = store.save({ expectedRevision: 'initial', settings: { runCacheAfterDays: 8 } });
  assert.deepEqual(new SettingsStore(store.path).get(), settings);
  assert.throws(() => store.save({ expectedRevision: 'initial', settings: { runCacheAfterDays: null } }), { code: 'REVISION_CONFLICT' });
});
test('cleanup is opt-in, expires finished caches including archived/deleted runs, and keeps records', (t) => {
  const { roots, job } = setup(t);
  const old = job('old'),
    archived = job('archived', { hiddenAt: new Date(now).toISOString() }),
    deleted = job('deleted', { deletedAt: new Date(now).toISOString() });
  const recent = job('recent', { finishedAt: new Date(now - 86400000).toISOString() });
  const records = [old, archived, deleted, recent];
  assert.equal(cleanRunCaches(records, { runCacheAfterDays: null }, roots, now).removed.length, 0);
  assert.ok(existsSync(old.runDir!));
  const report = cleanRunCaches(records, { runCacheAfterDays: 8 }, roots, now);
  assert.equal(report.removed.length, 3);
  assert.ok(report.removed.every((entry) => entry.bytes > 0));
  assert.equal(records.length, 4);
  assert.equal(old.cacheClearedAt, report.at);
  assert.equal(existsSync(old.runDir!), false);
  assert.equal(existsSync(join(roots.generated, old.id)), false);
  assert.ok(existsSync(recent.runDir!));
  assert.equal(cleanRunCaches(records, { runCacheAfterDays: 8 }, roots, now).removed.length, 0);
});
test('cleanup protects active work, replay sources, shared paths and invalid dates', (t) => {
  const { roots, job } = setup(t);
  const source = job('source'),
    reused = job('reused');
  const jobs = [
    source,
    reused,
    job('reuse-reader', { status: 'running', specSelection: { mode: 'reuse', reason: 'compatible', sourceRun: reused.runDir } }),
    job('queued', { status: 'queued', replayOf: source.id }),
    job('running', { status: 'running' }),
    job('cancelling', { status: 'cancelling' }),
    job('invalid', { finishedAt: 'unknown' }),
  ];
  jobs.push({ ...source, id: 'shared-active', status: 'running' });
  const report = cleanRunCaches(jobs, { runCacheAfterDays: 1 }, roots, now);
  assert.equal(report.removed.length, 0);
  assert.ok(jobs.every((j) => existsSync(j.runDir!)));
});
test('cleanup refuses arbitrary paths, root directories and symbolic links', (t) => {
  const { dir, roots, job, file } = setup(t),
    template = job('template');
  const outside = join(dir, 'outside');
  file(join(outside, 'keep.txt'));
  symlinkSync(outside, join(roots.runs, 'linked'));
  rmSync(join(roots.generated, 'template'), { recursive: true });
  symlinkSync(outside, join(roots.generated, 'template'));
  const records = [
    template,
    { ...template, id: 'outside', runDir: outside },
    { ...template, id: 'root', runDir: roots.runs },
    { ...template, id: 'linked', runDir: join(roots.runs, 'linked') },
  ];
  const report = cleanRunCaches(records, { runCacheAfterDays: 1 }, roots, now);
  assert.equal(report.removed.length, 0);
  assert.equal(report.failed.length, 4);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'evidence');
  assert.ok(existsSync(join(template.runDir!, 'explore/report.json')));
});
