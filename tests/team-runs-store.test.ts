import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { createRunsStore } from '../src/team/client/runs-store.ts';
import { teamRunSchema } from '../src/team/contracts.ts';
import type { TeamApi } from '../src/team/client/api.ts';
const user = { id: randomUUID(), name: 'e2e-agent-member' };
const other = { id: randomUUID(), name: 'e2e-agent-teammate' };
const row = (owner = user) =>
  teamRunSchema.parse({
    id: randomUUID(),
    orgId: randomUUID(),
    title: 'Run',
    status: 'queued',
    initiatedBy: owner,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
const page = (items = [row()]) => ({
  items,
  users: [user, other],
  stats: { total: items.length, active: items.length, passed: 0, failed: 0 },
  nextCursor: null,
});
const stub =
  (
    handler: (path: string, options: Parameters<TeamApi>[2]) => unknown,
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
test('rapid user changes cannot show stale runs or totals; pagination keeps the user filter', async (t) => {
  const late = deferred<unknown>();
  let requested = '';
  const current = row(other);
  const store = createRunsStore(
    stub((path) => {
      requested = path;
      if (path.includes(user.id)) return late.promise;
      return page([current]);
    }),
    'member:org',
  );
  t.after(() => store.dispose());
  const old = store.loadPage(user.id);
  await setImmediate();
  await store.loadPage(other.id, 'cursor');
  assert.ok(requested.includes(`userId=${other.id}`));
  assert.ok(requested.includes('after=cursor'));
  late.resolve(page([row(user), row(user)]));
  await old;
  assert.deepEqual(store.getSnapshot().ids, [current.id]);
  assert.equal(store.getSnapshot().stats?.total, 1);
  assert.equal(store.collection.size, 1);
  assert.equal(store.userCollection.size, 2);
});
test('failed filter switches clear old records and totals and allow retry', async (t) => {
  let fails = false;
  const store = createRunsStore(
    stub(() => {
      if (fails) throw new Error('Unavailable');
      return page();
    }),
    'member:org',
  );
  t.after(() => store.dispose());
  await store.loadPage(user.id);
  fails = true;
  await store.loadPage(other.id);
  assert.deepEqual(store.getSnapshot().ids, []);
  assert.equal(store.getSnapshot().stats, null);
  assert.equal(store.getSnapshot().error, 'Unavailable');
  fails = false;
  await store.loadPage(other.id);
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().ids.length, 1);
});
test('identity disposal aborts late data and clears both run and user collections', async () => {
  const late = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const store = createRunsStore(
    stub((_path, options) => {
      signal = options?.signal;
      return late.promise;
    }),
    'old',
  );
  const request = store.loadPage();
  await setImmediate();
  await store.dispose();
  assert.equal(signal?.aborted, true);
  late.resolve(page());
  await request;
  assert.equal(store.collection.size, 0);
  assert.equal(store.userCollection.size, 0);
  assert.equal(store.getSnapshot().stats, null);
});
test('detail polling cannot regress a run revision; cache remains bounded while its thread is pinned', async (t) => {
  const item = row();
  const store = createRunsStore(
    stub((path) =>
      path.startsWith('/runs/')
        ? item
        : page([
            { ...item, revision: 3 },
            ...Array.from({ length: 24 }, () => row()),
          ]),
    ),
    'member:org',
  );
  t.after(() => store.dispose());
  const unpin = store.pin(item.id);
  for (let n = 0; n < 12; n++) await store.loadPage(undefined, String(n));
  await store.loadOne(item.id);
  assert.equal(store.collection.get(item.id)?.revision, 3);
  assert.ok(store.collection.size <= 150);
  unpin();
});
