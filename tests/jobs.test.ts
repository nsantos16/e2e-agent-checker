import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('job recovery, atomic preflight, idempotency, queued cancellation and replay guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-jobs-')),
    oldPath = process.env.PATH,
    oldJobs = process.env.E2E_JOBS_PATH;
  process.env.E2E_JOBS_PATH = join(dir, 'jobs.json');
  process.env.PATH = dir + ':' + oldPath;
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(
    join(dir, 'jobs.json'),
    JSON.stringify([
      {
        id: 'interrupted',
        status: 'running',
        createdAt: new Date().toISOString(),
        project: 'DEMO',
        caseId: 6003,
        worktree: dir,
        role: 'eugene',
        log: [],
      },
    ]),
  );
  writeFileSync(
    join(dir, 'claude'),
    `#!/usr/bin/env node\nsetTimeout(()=>console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'})),80);`,
    { mode: 0o755 },
  );
  const { submitBatch, cancelJob, replayJob, listJobs, getJob } = await import('../src/jobs.ts');
  try {
    assert.equal(getJob('interrupted')?.status, 'interrupted');
    assert.ok(JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8'))[0].finishedAt);
    await assert.rejects(
      submitBatch({
        cases: [{ project: 'DEMO', id: 6003 }],
        worktree: dir,
        targets: [
          { provider: 'claude-code', model: 'sonnet' },
          { provider: 'claude-code', model: 'nonexistent' },
        ],
      }),
      /model catalog/,
    );
    assert.equal(listJobs().length, 1);
    const input = {
      cases: [{ project: 'DEMO', id: 6003 }],
      worktree: dir,
      targets: [
        { provider: 'claude-code', model: 'sonnet' },
        { provider: 'claude-code', model: 'haiku' },
      ],
      idempotencyKey: 'same-batch',
    };
    const batch = await submitBatch(input);
    assert.equal(batch.length, 2);
    assert.equal(batch[0].status, 'running');
    assert.equal(batch[1].status, 'queued');
    assert.equal(cancelJob(batch[1].id).status, 'cancelled');
    assert.equal(cancelJob(batch[1].id).status, 'cancelled');
    assert.deepEqual(
      (await submitBatch(input)).map((j) => j.id),
      batch.map((j) => j.id),
    );
    await assert.rejects(submitBatch({ ...input, role: 'eugene', limits: { maxAttempts: 1, timeoutMs: 10000 } }), /different inputs/);
    assert.throws(() => replayJob('interrupted'), /no saved run/);
    cancelJob(batch[0].id);
    for (let i = 0; i < 100 && getJob(batch[0].id)?.status === 'cancelling'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(getJob(batch[0].id)?.status, 'cancelled');
    assert.ok(getJob(batch[0].id)?.timing?.activeMs);
  } finally {
    process.env.PATH = oldPath;
    if (oldJobs === undefined) delete process.env.E2E_JOBS_PATH;
    else process.env.E2E_JOBS_PATH = oldJobs;
    rmSync(dir, { recursive: true, force: true });
  }
});
