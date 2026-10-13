import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { jobSummary, readEvidence, artifactPath } from '../src/agent-view.ts';
import { atomicJson } from '../src/network.ts';
import type { Job } from '../src/jobs.ts';

const fixture = (runDir: string): Job => ({
  id: 'agent-test',
  project: 'DEMO',
  caseId: 6003,
  status: 'done',
  outcome: 'fail',
  role: 'test',
  worktree: '/test/worktree',
  createdAt: '2026-01-01T00:00:00Z',
  runDir,
  log: Array.from({ length: 80 }, (_, i) => `${i} ${'long diagnostic log '.repeat(40)}`),
  steps: [{ position: 1, verdict: 'fail', evidence: 'API rejected the request' }],
  replay: { status: 'failed', failedStep: 'Submit', error: 'Expected success' },
});
function populate(dir: string) {
  mkdirSync(join(dir, 'explore'), { recursive: true });
  mkdirSync(join(dir, 'codify'), { recursive: true });
  writeFileSync(join(dir, 'codify/DEMO-6003.spec.ts'), 'spec contents');
  atomicJson(join(dir, 'explore/case.json'), { project: 'LOCAL', id: 1, title: 'Original case snapshot' });
  atomicJson(join(dir, 'explore/report.json'), { verdict: 'fail', notes: 'report '.repeat(1000) });
  atomicJson(join(dir, 'explore/network.json'), {
    version: 1,
    stage: 'explore',
    total: 7,
    errorCount: 6,
    dropped: 0,
    requests: Array.from({ length: 7 }, (_, i) => ({
      id: `row-${i}`,
      at: `2026-01-01T00:00:0${i}Z`,
      stage: 'explore',
      method: 'GET',
      url: `https://example.test/api/${i}`,
      status: i === 0 ? 200 : 503,
      requestId: `correlation-${i}`,
      errorBody: { message: 'Detailed diagnostic response' },
    })),
  });
  atomicJson(join(dir, 'live/browser.json'), { stage: 'replay', status: 'closed', updatedAt: '2026-01-01T00:00:00Z', frameAt: 'frame-1' });
  writeFileSync(join(dir, 'live/frame.jpg'), Buffer.from([255, 216, 255, 217]));
}

test('agent summaries stay small; evidence is paged and constrained to the job directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-agent-'));
  try {
    populate(dir);
    const job = fixture(dir),
      compact = jobSummary(job, 'http://localhost:4100');
    assert.equal(compact.terminal, true);
    assert.equal(compact.outcome, 'fail');
    assert.equal(compact.next, 'get_evidence');
    assert.equal(compact.network?.failures.length, 3);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(job).length / 10);
    assert.equal(compact.revision, jobSummary(job, 'http://localhost:4100').revision);
    assert.notEqual(compact.revision, jobSummary({ ...job, status: 'failed' }, 'http://localhost:4100').revision);
    assert.equal('log' in compact, false);
    assert.match(readEvidence(job, '', { artifact: 'case' }).text!, /Original case snapshot/);
    const evidence = readEvidence(job, 'http://localhost:4100');
    assert.equal(evidence.failedSteps?.[0].position, 1);
    const first = readEvidence(job, '', { artifact: 'report', limit: 20 });
    const next = readEvidence(job, '', { artifact: 'report', offset: first.nextOffset!, limit: 20 });
    assert.equal(first.text!.length, 20);
    assert.equal(next.offset, 20);
    const outside = join(dir, '../outside-' + dir.split('/').at(-1));
    writeFileSync(outside, 'must not be exposed');
    symlinkSync(outside, join(dir, 'pr-comment.md'));
    try {
      assert.equal(artifactPath(job, 'comment'), undefined);
      assert.throws(() => readEvidence(job, '', { artifact: 'comment' }), /not been captured/);
      assert.throws(() => readEvidence(job, '', { artifact: '../../outside' }), /artifact URL/);
    } finally {
      rmSync(outside);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real local API and stdio MCP expose compact jobs, selected diagnostics, paged evidence and frame deltas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-api-'));
  populate(dir);
  const jobs = join(dir, 'jobs.json');
  writeFileSync(jobs, JSON.stringify([fixture(dir)]));
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const env = {
    ...process.env,
    E2E_APP_PORT: String(port),
    E2E_APP_OPEN: '0',
    E2E_JOBS_PATH: jobs,
    E2E_CASES_PATH: join(dir, 'cases.json'),
    E2E_ENVIRONMENTS_PATH: join(dir, 'environments.json'),
  } as Record<string, string>;
  const app = spawn(process.execPath, ['src/app/server.ts'], { env, stdio: 'ignore' });
  const closed = new Promise<void>((r) => app.once('exit', () => r()));
  const client = new Client({ name: 'real-api-test', version: '1' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await fetch(base + '/api/config').then(
        (r) => r.ok,
        () => false,
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, 'test server started');
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp-server.ts'], env, stderr: 'pipe' }));
    const call = async (name: string, args: object) => {
      const response = await client.callTool({ name, arguments: args as Record<string, unknown> });
      assert.ok(!response.isError, JSON.stringify(response.content));
      return (response.structuredContent as any).data;
    };
    const definition = {
      id: 'staging',
      name: 'Staging',
      kind: 'hosted',
      baseUrl: 'https://staging.example.test',
      users: [{ id: 'qa', name: 'QA', usernameRef: 'env://QA_USERNAME', passwordRef: 'env://QA_PASSWORD' }],
    };
    const environment = await call('save_environment', { environment: definition });
    const catalog = await call('list_environments', {});
    assert.equal(catalog.environments.find((e: any) => e.id === 'staging').users[0].passwordRef, undefined);
    const editable = await call('list_environments', { detail: true });
    assert.equal(editable.environments.find((e: any) => e.id === 'staging').users[0].passwordRef, 'env://QA_PASSWORD');
    const staleEnvironment = await client.callTool({
      name: 'save_environment',
      arguments: { environment: definition, expectedRevision: 'stale' },
    });
    assert.equal(staleEnvironment.isError, true);
    const rawSecret = await client.callTool({
      name: 'save_environment',
      arguments: {
        environment: { ...definition, users: [{ ...definition.users[0], passwordRef: 'not-a-reference' }] },
        expectedRevision: environment.revision,
      },
    });
    assert.equal(rawSecret.isError, true);
    const deletedEnvironment = await call('delete_environment', { environmentId: 'staging', expectedRevision: environment.revision });
    assert.equal(deletedEnvironment.deleted, true);
    const created = await call('create_case', { title: 'Native case', idempotencyKey: 'native-1' });
    assert.equal(created.project, 'LOCAL');
    assert.equal(created.status, 'draft');
    assert.equal(created.steps, 0, 'mutation acknowledgment does not echo full steps');
    assert.equal((await call('create_case', { title: 'Native case', idempotencyKey: 'native-1' })).id, created.id);
    const full = await call('get_case', { project: 'LOCAL', caseId: created.id });
    assert.equal(full.source.kind, 'local');
    const activated = await call('update_case', {
      project: 'LOCAL',
      caseId: full.id,
      expectedRevision: full.revision,
      changes: { status: 'active', tags: ['smoke'], steps: [{ action: 'Open page', expected_result: 'Heading visible' }] },
    });
    const stale = await client.callTool({
      name: 'update_case',
      arguments: { project: 'LOCAL', caseId: full.id, expectedRevision: full.revision, changes: { title: 'Stale edit' } },
    });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale.content), /REVISION_CONFLICT/);
    assert.equal((await call('list_cases', { project: 'LOCAL', tag: 'smoke', status: 'active' })).total, 1);
    const archived = await call('delete_case', { project: 'LOCAL', caseId: full.id, expectedRevision: activated.revision });
    assert.equal((await call('list_cases', { project: 'LOCAL' })).total, 0);
    assert.equal((await call('list_cases', { project: 'LOCAL', status: 'archived' })).total, 1);
    assert.equal(
      (await call('get_case', { project: 'LOCAL', qaseCaseId: full.id })).status,
      'archived',
      'legacy ID alias remains supported',
    );
    await call('update_case', { project: 'LOCAL', caseId: full.id, expectedRevision: archived.revision, changes: { status: 'active' } });
    const ambiguous = await client.callTool({
      name: 'get_case',
      arguments: { project: 'LOCAL', caseId: full.id, qaseCaseId: full.id + 1 },
    });
    assert.equal(ambiguous.isError, true);
    const crossOrigin = await fetch(base + '/api/cases/create', {
      method: 'POST',
      headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Forbidden' }),
    });
    assert.equal(crossOrigin.status, 403);
    const job = await call('get_job', { jobId: 'agent-test' });
    assert.equal(job.outcome, 'fail');
    assert.equal(job.log, undefined);
    assert.match(job.viewerUrl, /\?job=agent-test$/);
    const wait = await call('wait_jobs', { jobIds: ['agent-test'], revisions: { 'agent-test': job.revision }, waitMs: 2000 });
    assert.deepEqual(wait.jobs, []);
    assert.deepEqual(wait.pendingJobIds, []);
    assert.equal(wait.timedOut, false);
    const network = await call('get_network', { jobId: 'agent-test' });
    assert.equal(network.requests.length, 5);
    assert.equal(network.nextCursor, 5);
    assert.equal(network.requests[0].errorBody, undefined);
    const second = await call('get_network', { jobId: 'agent-test', cursor: 5 });
    assert.equal(second.requests.length, 1);
    assert.equal(second.nextCursor, null);
    const success = await call('get_network', { jobId: 'agent-test', requestId: 'row-0', detail: true });
    assert.equal(success.requests.length, 1);
    assert.equal(success.requests[0].status, 200);
    assert.equal(success.requests[0].errorBody.message, 'Detailed diagnostic response');
    const page = await call('get_evidence', { jobId: 'agent-test', artifact: 'report', limit: 30 });
    assert.equal(page.text.length, 30);
    assert.equal(page.nextOffset, 30);
    const evidence = await call('get_evidence', { jobId: 'agent-test' });
    const artifact = await fetch(evidence.artifacts.find((a: any) => a.id === 'spec').url);
    assert.equal(await artifact.text(), 'spec contents');
    assert.equal((await fetch(base + '/api/jobs/agent-test/artifacts/secret')).status, 404);
    const frame = await client.callTool({ name: 'get_browser_frame', arguments: { jobId: 'agent-test' } });
    assert.ok((frame.content as any[]).some((c) => c.type === 'image'));
    const unchanged = await client.callTool({ name: 'get_browser_frame', arguments: { jobId: 'agent-test', knownFrameAt: 'frame-1' } });
    assert.equal((unchanged.structuredContent as any).data.unchanged, true);
    assert.equal((unchanged.content as any[]).length, 1);
    const cases = await call('list_cases', { query: '6003', limit: 1 });
    assert.equal(cases.cases[0].id, 6003);
    const fullCase = await call('get_case', { qaseCaseId: 6003 });
    assert.ok(fullCase.steps.length > 0);
    const workflow = await client.readResource({ uri: 'checker://workflow' });
    assert.match(JSON.stringify(workflow.contents), /done means/);
  } finally {
    await client.close();
    app.kill('SIGTERM');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
