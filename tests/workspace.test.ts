import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../src/app/client/workspace.ts';
import type { Api } from '../src/app/client/api.ts';
import type { CaseSummary, JobView, Target } from '../src/app/client/types.ts';
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

test('shared UI lifecycle and commands never fall back to local execution APIs', async () => {
  const calls: string[] = [];
  const workspace = createWorkspace(
    async <T>(path: string) => {
      calls.push(path);
      return [] as T;
    },
    { localExecution: false },
  );
  const stop = workspace.start();
  try {
    assert.equal(workspace.getSnapshot().ready, true);
    assert.equal(workspace.getSnapshot().activeJob, null);
    assert.deepEqual(workspace.getSnapshot().targets, []);
    await workspace.run(['shared-case']);
    await assert.rejects(workspace.refreshCases(), /Local execution is unavailable/);
    assert.deepEqual(calls, []);
    assert.match(workspace.getSnapshot().error, /local app/);
  } finally {
    stop();
  }
});

test('React workspace submits hosted case/model selections and prunes archived cases', async () => {
  const submitted: any[] = [];
  let cases = [{ project: 'QA', id: 1, revision: 'case-1', title: 'Fixture', steps: 1, status: 'active' }];
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

const localEnvironment = { id: 'local', name: 'Local development', kind: 'worktree' as const, users: [{ id: 'qa', name: 'QA' }] };
const stagingEnvironment = {
  id: 'staging',
  name: 'Staging',
  kind: 'hosted' as const,
  baseUrl: 'https://fixture.test',
  users: [{ id: 'viewer', name: 'Viewer' }],
};

test('an older environment refresh cannot undo a newly saved environment selection', async () => {
  const catalog = deferred<(typeof localEnvironment)[]>();
  let first = true;
  const workspace = createWorkspace(async <T>() => {
    if (!first) return [localEnvironment] as T;
    first = false;
    return (await catalog.promise) as T;
  });
  workspace.setEnvironments([localEnvironment]);
  const polling = workspace.refreshEnvironments();
  workspace.setEnvironments([localEnvironment, stagingEnvironment]);
  workspace.chooseEnvironment('staging');
  catalog.resolve([localEnvironment]);
  await polling;
  assert.equal(workspace.getSnapshot().environmentId, 'staging');
  assert.equal(workspace.getSnapshot().userId, 'viewer');
  assert.equal(workspace.getSnapshot().environments.length, 2);
  await workspace.refreshEnvironments();
  assert.equal(workspace.getSnapshot().environmentId, 'local', 'a later catalog can still remove an unavailable selection');
  assert.equal(workspace.getSnapshot().userId, 'qa');
});

test('delayed startup configuration cannot replace a newer environment selection', async () => {
  const config = deferred<{ roles: string[]; environments: (typeof localEnvironment)[] }>();
  const workspace = createWorkspace(async <T>(path: string) => (path === '/api/config' ? await config.promise : []) as T);
  const stop = workspace.start();
  try {
    workspace.setEnvironments([localEnvironment, stagingEnvironment]);
    workspace.chooseEnvironment('staging');
    config.resolve({ roles: ['qa'], environments: [localEnvironment] });
    await turn();
    assert.equal(workspace.getSnapshot().ready, true);
    assert.equal(workspace.getSnapshot().environmentId, 'staging');
    assert.equal(workspace.getSnapshot().userId, 'viewer');
  } finally {
    stop();
  }
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

const testCase: CaseSummary = { project: 'QA', id: 1, revision: 'case-1', title: 'Fixture', steps: 1, status: 'active' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('case removal uses the displayed revision, prunes selection and ignores an older catalog poll', async () => {
  const catalog = deferred<CaseSummary[]>();
  const requests: unknown[] = [];
  const workspace = createWorkspace(async <T>(path: string, body?: unknown) => {
    if (path === '/api/cases') return (await catalog.promise) as T;
    assert.equal(path, '/api/cases/QA/1/delete');
    requests.push(body);
    return {} as T;
  });
  workspace.patch({
    cases: [testCase],
    selected: new Set(['QA-1']),
    jobs: [job('ongoing')],
    activeJob: 'ongoing',
  });
  const poll = workspace.refreshCases();
  await Promise.all([workspace.removeCase(testCase), workspace.removeCase(testCase)]);
  assert.deepEqual(requests, [{ expectedRevision: 'case-1' }]);
  catalog.resolve([testCase]);
  await poll;
  assert.deepEqual(workspace.getSnapshot().cases, []);
  assert.equal(workspace.getSnapshot().selected.size, 0);
  assert.equal(workspace.getSnapshot().activeJob, 'ongoing');
  assert.equal(workspace.getSnapshot().jobs.length, 1, 'archiving a case does not remove its runs');
  await workspace.refreshCases();
  assert.equal(workspace.getSnapshot().cases.length, 1, 'a later catalog restore can show the case again');
});

test('failed removals keep the item and selection and report the error', async () => {
  const workspace = createWorkspace(async () => {
    throw new Error('Case changed or run is still active');
  });
  workspace.patch({ cases: [testCase], selected: new Set(['QA-1']), jobs: [job('first')], activeJob: 'first' });
  await workspace.removeCase(testCase).catch(workspace.report);
  assert.deepEqual(workspace.getSnapshot().cases, [testCase]);
  assert.deepEqual([...workspace.getSnapshot().selected], ['QA-1']);
  await workspace.removeJob('first').catch(workspace.report);
  assert.equal(workspace.getSnapshot().activeJob, 'first');
  assert.equal(workspace.getSnapshot().jobs.length, 1);
  assert.equal(workspace.getSnapshot().error, 'Case changed or run is still active');
});

test('run removal clears its card and ignores polling evidence already in flight', async () => {
  const evidence = deferred<JobView>();
  const workspace = createWorkspace(async <T>(path: string) => {
    if (path === '/api/jobs') return [job('first'), job('second')] as T;
    if (path.endsWith('/remove')) return {} as T;
    return (await evidence.promise) as T;
  });
  workspace.patch({
    jobs: [job('first'), job('second')],
    details: { first: job('first') },
    activeJob: 'first',
    expanded: new Set(['first']),
  });
  const poll = workspace.refreshJobs();
  await turn();
  await workspace.removeJob('first');
  evidence.resolve(job('first'));
  await poll;
  assert.equal(workspace.getSnapshot().activeJob, null);
  assert.equal(workspace.getSnapshot().details.first, undefined);
  assert.equal(workspace.getSnapshot().expanded.has('first'), false);
  assert.deepEqual(
    workspace.getSnapshot().jobs.map((j) => j.id),
    ['second'],
  );
});

test('a late list response cannot resurrect a removed run or disturb a newer selection', async () => {
  const listing = deferred<JobView[]>();
  const removal = deferred<unknown>();
  const workspace = createWorkspace(async <T>(path: string) => {
    if (path === '/api/jobs') return (await listing.promise) as T;
    if (path.endsWith('/remove')) return (await removal.promise) as T;
    return job('second') as T;
  });
  workspace.patch({ jobs: [job('first'), job('second')], activeJob: 'first' });
  const poll = workspace.refreshJobs();
  const remove = workspace.removeJob('first');
  await workspace.selectJob('second');
  removal.resolve({});
  await remove;
  listing.resolve([job('first')]);
  await poll;
  assert.equal(workspace.getSnapshot().activeJob, 'second');
  assert.deepEqual(
    workspace.getSnapshot().jobs.map((j) => j.id),
    ['second'],
  );
  assert.equal(workspace.getSnapshot().details.second?.id, 'second');
});

test('late selection and expansion responses cannot repopulate removed run details', async () => {
  for (const action of ['selectJob', 'toggleExpanded'] as const) {
    const evidence = deferred<JobView>();
    const workspace = createWorkspace(async <T>(path: string) => (path.endsWith('/remove') ? {} : await evidence.promise) as T);
    workspace.patch({ jobs: [job('first')] });
    const opening = workspace[action]('first');
    await workspace.removeJob('first');
    evidence.resolve(job('first'));
    await opening;
    assert.equal(workspace.getSnapshot().activeJob, null);
    assert.equal(workspace.getSnapshot().expanded.size, 0);
    assert.deepEqual(workspace.getSnapshot().details, {});
    assert.deepEqual(workspace.getSnapshot().jobs, []);
  }
});

test('removing the selected run clears its URL and persisted selection across workspace reloads', async (t) => {
  const saved = new Map([['active-job', JSON.stringify('first')]]);
  let currentUrl = new URL('http://localhost:4100/?job=first&keep=1');
  const globals = {
    window: {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
        removeItem: (key: string) => saved.delete(key),
      },
    },
    location: {
      get href() {
        return currentUrl.href;
      },
      get search() {
        return currentUrl.search;
      },
      protocol: 'http:',
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: URL) => {
        currentUrl = url;
      },
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const api: Api = async <T>(path: string) => (path === '/api/jobs' ? [] : {}) as T;
  const workspace = createWorkspace(api);
  assert.equal(workspace.getSnapshot().activeJob, 'first');
  await workspace.removeJob('first');
  assert.equal(saved.has('active-job'), false);
  assert.equal(currentUrl.search, '?keep=1');
  const reloaded = createWorkspace(api);
  await reloaded.refreshJobs();
  assert.equal(reloaded.getSnapshot().activeJob, null);
  assert.deepEqual(reloaded.getSnapshot().jobs, []);
});

test('sidebar and archive load older pages so organized runs remain reachable', async () => {
  const records = Array.from({ length: 1070 }, (_, i) => job(String(i)));
  records[1069].pinnedAt = '2026-01-01T00:00:00Z';
  const workspace = createWorkspace(async <T>(path: string) => {
    if (path.startsWith('/api/cases')) return [] as T;
    const url = new URL(path, 'http://localhost');
    const cursor = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 60);
    return records.slice(cursor, cursor + limit) as T;
  });
  await workspace.refreshJobs();
  assert.equal(workspace.getSnapshot().jobs.length, 1070);
  assert.ok(workspace.getSnapshot().jobs.at(-1)?.pinnedAt);
  await workspace.refreshArchive();
  assert.equal(workspace.getSnapshot().archivedJobs.length, 1070);
});

test('a run deleted in another workspace clears its selected card on polling', async () => {
  const workspace = createWorkspace(async <T>(path: string) => {
    if (path === '/api/jobs') return [job('second')] as T;
    throw Object.assign(new Error('Unknown job'), { status: 404 });
  });
  workspace.patch({ jobs: [job('first')], details: { first: job('first') }, activeJob: 'first', expanded: new Set(['first']) });
  await workspace.refreshJobs();
  assert.equal(workspace.getSnapshot().activeJob, null);
  assert.equal(workspace.getSnapshot().expanded.size, 0);
  assert.deepEqual(workspace.getSnapshot().details, {});
  assert.deepEqual(
    workspace.getSnapshot().jobs.map((j) => j.id),
    ['second'],
  );
});

test('permanent deletion ignores older list and detail responses', async () => {
  const evidence = deferred<JobView>();
  const workspace = createWorkspace(async <T>(path: string) => {
    if (path === '/api/jobs') return [job('first')] as T;
    if (path.endsWith('/delete')) return {} as T;
    return (await evidence.promise) as T;
  });
  workspace.patch({ jobs: [job('first')], details: { first: job('first') }, activeJob: 'first', expanded: new Set(['first']) });
  const poll = workspace.refreshJobs();
  await turn();
  await workspace.deleteItem({ kind: 'run', value: job('first') });
  evidence.resolve(job('first'));
  await poll;
  assert.equal(workspace.getSnapshot().activeJob, null);
  assert.deepEqual(workspace.getSnapshot().jobs, []);
  assert.deepEqual(workspace.getSnapshot().details, {});
});
