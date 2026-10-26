import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../src/app/client/workspace.ts';
import type { Api } from '../src/app/client/api.ts';
import type { JobView, Target } from '../src/app/client/types.ts';
const job = (id: string): JobView => ({
  id,
  project: 'QA',
  caseId: 1,
  title: id,
  worktree: '',
  role: 'qa',
  status: 'done',
  outcome: 'pass',
  createdAt: '2026-01-01T00:00:00Z',
  log: [],
});
const target: Target = { provider: 'codex', model: 'fixture', authMode: 'subscription' };
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

test('React workspace submits hosted case/model selections and prunes archived cases', async () => {
  const submitted: any[] = [];
  let cases = [{ project: 'QA', id: 1, title: 'Fixture', steps: 1, status: 'active' }];
  const api: Api = async <T>(path: string, body?: unknown) => {
    if (path === '/api/cases') return cases as T;
    if (path === '/api/jobs' && body) {
      submitted.push(body);
      return ['result'] as T;
    }
    if (path === '/api/jobs') return [job('result')] as T;
    if (path === '/api/jobs/result') return job('result') as T;
    throw new Error('Unexpected route: ' + path);
  };
  const workspace = createWorkspace(api);
  workspace.setEnvironments([
    { id: 'staging', name: 'Staging', kind: 'hosted', baseUrl: 'https://fixture.test', users: [{ id: 'qa', name: 'QA' }] },
  ]);
  workspace.patch({
    providers: [
      {
        id: 'codex',
        name: 'Fixture',
        installed: true,
        ready: true,
        auth: 'subscription',
        loginCommand: '',
        models: [{ id: 'fixture', name: 'Fixture' }],
      },
    ],
    targets: [target],
  });
  await workspace.refreshCases();
  workspace.selectCase('QA-1');
  await workspace.run();
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].cases, [{ project: 'QA', id: 1 }]);
  assert.deepEqual(submitted[0].targets, [target]);
  assert.equal(submitted[0].environmentId, 'staging');
  assert.equal(submitted[0].userId, 'qa');
  assert.equal(submitted[0].worktree, undefined);
  assert.equal(submitted[0].forceFresh, false);
  assert.equal(workspace.getSnapshot().activeJob, 'result');
  workspace.patch({ providers: [] });
  workspace.selectCase('QA-1');
  await workspace.run();
  assert.equal(submitted.length, 2, 'automatic reuse is available without provider readiness');
  workspace.patch({ forceFresh: true });
  workspace.selectCase('QA-1');
  await workspace.run();
  assert.equal(submitted.length, 2, 'fresh authoring still asks for a ready provider');
  workspace.selectCase('QA-1');
  cases = [];
  await workspace.refreshCases();
  assert.equal(workspace.getSnapshot().selected.size, 0);
  workspace.selectCase('QA-1');
  assert.equal(workspace.getSnapshot().selected.size, 0);
});

test('late run-detail responses cannot replace a newer selected run', async () => {
  let resolveFirst!: (value: JobView) => void;
  const first = new Promise<JobView>((resolve) => {
    resolveFirst = resolve;
  });
  const api: Api = async <T>(path: string) => (path.endsWith('/first') ? await first : job('second')) as T;
  const workspace = createWorkspace(api);
  const oldSelection = workspace.selectJob('first');
  await workspace.selectJob('second');
  resolveFirst(job('first'));
  await oldSelection;
  assert.equal(workspace.getSnapshot().activeJob, 'second');
  assert.equal(workspace.getSnapshot().jobs[0].id, 'second');
  assert.equal(workspace.getSnapshot().details.first, undefined);
});

test('workspace startup deduplicates requests and unmount aborts pending work without publishing stale data', async () => {
  const requests: { path: string; signal?: AbortSignal }[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api: Api = async <T>(path: string, _body?: unknown, signal?: AbortSignal) => {
    requests.push({ path, signal });
    await barrier;
    return (path === '/api/config' ? { roles: [], environments: [] } : []) as T;
  };
  const workspace = createWorkspace(api);
  const stop = workspace.start();
  workspace.start();
  assert.equal(requests.length, 5, 'independent startup reads begin in parallel only once');
  const refresh = workspace.refreshCases();
  assert.equal(requests.filter((r) => r.path === '/api/cases').length, 1);
  const cancelled = assert.rejects(refresh, { name: 'AbortError' });
  stop();
  assert.ok(requests.every((r) => r.signal?.aborted));
  release();
  await cancelled;
  await turn();
  assert.equal(workspace.getSnapshot().ready, false);
  assert.equal(workspace.getSnapshot().error, '');
  assert.deepEqual(workspace.getSnapshot().cases, []);
});

test('an older polling response preserves a run selected while its evidence was loading', async () => {
  let release!: (value: JobView) => void;
  const evidence = new Promise<JobView>((resolve) => {
    release = resolve;
  });
  const api: Api = async <T>(path: string) => {
    if (path === '/api/jobs') return [job('first')] as T;
    return (path.endsWith('/first') ? await evidence : job('second')) as T;
  };
  const workspace = createWorkspace(api);
  workspace.patch({ jobs: [job('first')], activeJob: 'first', expanded: new Set(['first']) });
  const poll = workspace.refreshJobs();
  await turn();
  await workspace.selectJob('second');
  release(job('first'));
  await poll;
  assert.equal(workspace.getSnapshot().activeJob, 'second');
  assert.ok(workspace.getSnapshot().jobs.some((job) => job.id === 'second'));
});
