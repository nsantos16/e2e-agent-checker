import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { createCasesStore } from '../src/team/client/cases-store.ts';
import {
  caseDraftSchema,
  teamCaseSchema,
  type TeamCase,
} from '../src/team/contracts.ts';
import type { TeamApi } from '../src/team/client/api.ts';

const draft = caseDraftSchema.parse({ title: 'Original title' });
const row = (overrides: Partial<TeamCase> = {}): TeamCase =>
  teamCaseSchema.parse({
    ...draft,
    id: randomUUID(),
    orgId: randomUUID(),
    revision: 1,
    createdByUserId: randomUUID(),
    updatedByUserId: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
type ApiOptions = Parameters<TeamApi>[2];
const stub =
  (
    handler: (path: string, options: ApiOptions) => unknown | Promise<unknown>,
  ): TeamApi =>
  async (path, schema, options) =>
    schema.parse(await handler(path, options));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('DB collection exposes optimistic edits and publishes the confirmed server revision', async (t) => {
  const original = row();
  const response = deferred<TeamCase>();
  let request: unknown;
  const store = createCasesStore(
    stub((path, options) => {
      if (options?.method === 'PATCH') {
        request = options.body;
        return response.promise;
      }
      return { items: [original], nextCursor: null };
    }),
    'member:org',
  );
  t.after(() => store.dispose());
  await store.loadPage('');
  const saving = store.update(
    original.id,
    { ...draft, title: 'Optimistic title' },
    1,
  );
  await setImmediate();
  assert.equal(store.collection.get(original.id)?.title, 'Optimistic title');
  assert.equal(store.collection.get(original.id)?.$hasPendingWrites, true);
  assert.deepEqual(request, {
    expectedRevision: 1,
    data: { ...draft, title: 'Optimistic title' },
  });
  response.resolve({ ...original, title: 'Optimistic title', revision: 2 });
  await saving;
  assert.equal(store.collection.get(original.id)?.revision, 2);
  assert.equal(store.collection.get(original.id)?.$hasPendingWrites, false);
});

test('rejected optimistic writes roll back and stale forms cannot adopt a newer revision', async (t) => {
  const original = row();
  let current = original;
  let writes = 0;
  const store = createCasesStore(
    stub((path, options) => {
      if (options?.method === 'PATCH') {
        writes++;
        throw new Error('Revision conflict');
      }
      return { items: [current], nextCursor: null };
    }),
    'member:org',
  );
  t.after(() => store.dispose());
  await store.loadPage('');
  await assert.rejects(
    store.update(original.id, { ...draft, title: 'Rejected' }, 1),
    /Revision conflict/,
  );
  assert.equal(store.collection.get(original.id)?.title, original.title);
  current = { ...original, revision: 2, title: 'Teammate edit' };
  await store.loadPage('');
  await assert.rejects(store.update(original.id, draft, 1), /Reload/);
  assert.equal(writes, 1);
  assert.equal(store.collection.get(original.id)?.title, 'Teammate edit');
});

test('late page responses and older snapshots cannot replace newer scope or revisions', async (t) => {
  const original = row();
  const old = deferred<unknown>();
  const store = createCasesStore(
    stub((path) => {
      if (path.includes('search=old')) return old.promise;
      return {
        items: [{ ...original, revision: 3, title: 'Latest' }],
        nextCursor: original.id,
      };
    }),
    'member:org',
  );
  t.after(() => store.dispose());
  const staleRequest = store.loadPage('old');
  await setImmediate();
  await store.loadPage('new');
  old.resolve({ items: [row()], nextCursor: null });
  await staleRequest;
  assert.deepEqual(store.getSnapshot().ids, [original.id]);
  assert.equal(store.getSnapshot().nextCursor, original.id);
  assert.equal(store.collection.get(original.id)?.revision, 3);
});

test('a snapshot arriving after mutation confirmation cannot regress a row', async (t) => {
  const original = row();
  const store = createCasesStore(
    stub((_path, options) =>
      options?.method === 'PATCH'
        ? { ...original, title: 'Saved', revision: 2 }
        : { items: [original], nextCursor: null },
    ),
    'member:org',
  );
  t.after(() => store.dispose());
  await store.loadPage('');
  await store.update(original.id, { ...draft, title: 'Saved' }, 1);
  await store.loadPage('');
  assert.equal(store.collection.get(original.id)?.revision, 2);
  assert.equal(store.collection.get(original.id)?.title, 'Saved');
});

test('disposing an identity aborts requests and late data cannot populate either identity', async () => {
  const late = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const previous = createCasesStore(
    stub((_path, options) => {
      signal = options?.signal;
      return late.promise;
    }),
    'A',
  );
  const loading = previous.loadPage('');
  await setImmediate();
  await previous.dispose();
  assert.equal(signal?.aborted, true);
  const next = createCasesStore(
    stub(() => ({ items: [], nextCursor: null })),
    'B',
  );
  try {
    late.resolve({ items: [row()], nextCursor: null });
    await loading;
    await next.loadPage('');
    assert.equal(previous.collection.size, 0);
    assert.equal(next.collection.size, 0);
    assert.deepEqual(previous.getSnapshot().ids, []);
  } finally {
    await next.dispose();
  }
});

test('failed searches clear previous scope, expose an error and can retry', async (t) => {
  let fails = false;
  const store = createCasesStore(
    stub(() => {
      if (fails) throw new Error('Service unavailable');
      return { items: [row()], nextCursor: null };
    }),
    'member:org',
  );
  t.after(() => store.dispose());
  await store.loadPage('first');
  fails = true;
  await store.loadPage('second');
  assert.deepEqual(store.getSnapshot().ids, []);
  assert.equal(store.getSnapshot().loading, false);
  assert.equal(store.getSnapshot().error, 'Service unavailable');
  fails = false;
  await store.loadPage('second');
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().ids.length, 1);
});

test('paging bounds cached rows while retaining the open case', async (t) => {
  const open = row();
  let first = true;
  const store = createCasesStore(
    stub(() => {
      const items = first ? [open] : Array.from({ length: 25 }, () => row());
      first = false;
      return { items, nextCursor: null };
    }),
    'member:org',
  );
  t.after(() => store.dispose());
  await store.loadPage('');
  const release = store.pin(open.id);
  for (let i = 0; i < 20; i++) await store.loadPage('page', randomUUID());
  assert.ok(store.collection.size <= 250);
  assert.equal(store.collection.get(open.id)?.title, open.title);
  release();
});
