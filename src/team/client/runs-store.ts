import {
  DbClient,
  collectionOptions,
  type SyncConfig,
} from '@tanstack/react-db';
import {
  runPageSchema,
  teamRunSchema,
  runUserSchema,
  type TeamRun,
  type RunUser,
  type RunStats,
} from '../contracts.ts';
import type { TeamApi } from './api.ts';

type PageState = {
  scope: string;
  ids: string[];
  nextCursor: string | null;
  stats: RunStats | null;
  loading: boolean;
  error: string | null;
};
export const runPageScope = (userId?: string, after?: string) =>
  `${userId ?? ''}:${after ?? ''}`;

// No Query cache: the identity-scoped DB collections own run and user records.
export function createRunsStore(api: TeamApi, identityKey: string) {
  const db = new DbClient();
  const lifetime = new AbortController();
  let runSync: Parameters<SyncConfig<TeamRun, string>['sync']>[0];
  let userSync: Parameters<SyncConfig<RunUser, string>['sync']>[0];
  let disposed = false;
  let generation = 0;
  let pageAbort: AbortController | undefined;
  let page: PageState = {
    scope: '',
    ids: [],
    nextCursor: null,
    stats: null,
    loading: false,
    error: null,
  };
  const rows = new Map<string, TeamRun>();
  const users = new Map<string, RunUser>();
  const pins = new Map<string, number>();
  const listeners = new Set<() => void>();
  const collection = db.collection(
    collectionOptions({
      id: `runs:${identityKey}`,
      schema: teamRunSchema,
      getKey: (row) => row.id,
      sync: {
        sync(params) {
          runSync = params;
          params.markReady();
          return () => {};
        },
      },
    }),
  );
  const userCollection = db.collection(
    collectionOptions({
      id: `run-users:${identityKey}`,
      schema: runUserSchema,
      getKey: (row) => row.id,
      sync: {
        sync(params) {
          userSync = params;
          params.markReady();
          return () => {};
        },
      },
    }),
  );
  const ready = Promise.all([collection.preload(), userCollection.preload()]);
  const publish = (next: PageState) => {
    if (disposed) return;
    page = next;
    listeners.forEach((fn) => fn());
  };
  function accept(items: TeamRun[]) {
    if (disposed) return;
    runSync.begin();
    for (const row of items) {
      const old = rows.get(row.id);
      if (old && old.revision > row.revision) continue;
      rows.set(row.id, row);
      runSync.write({ type: old ? 'update' : 'insert', value: row });
    }
    const retained = new Set([
      ...page.ids,
      ...pins.keys(),
      ...items.map((row) => row.id),
    ]);
    for (const id of rows.keys()) {
      if (rows.size <= 150) break;
      if (!retained.has(id)) {
        rows.delete(id);
        runSync.write({ type: 'delete', key: id });
      }
    }
    const receipt = runSync.commit(lifetime.signal);
    if (receipt !== true) void receipt.catch(() => {});
  }
  return {
    db,
    collection,
    userCollection,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => page,
    pin(id: string) {
      pins.set(id, (pins.get(id) ?? 0) + 1);
      return () => {
        const count = (pins.get(id) ?? 1) - 1;
        if (count) pins.set(id, count);
        else pins.delete(id);
      };
    },
    async loadPage(userId?: string, after?: string) {
      const current = ++generation;
      pageAbort?.abort();
      pageAbort = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, pageAbort.signal]);
      const scope = runPageScope(userId, after);
      publish({
        ...(scope === page.scope
          ? page
          : { ids: [], nextCursor: null, stats: null }),
        scope,
        loading: true,
        error: null,
      });
      try {
        await ready;
        const params = new URLSearchParams({
          limit: '25',
          ...(userId ? { userId } : {}),
          ...(after ? { after } : {}),
        });
        const result = await api(`/runs?${params}`, runPageSchema, { signal });
        if (disposed || current !== generation) return;
        accept(result.items);
        userSync.begin();
        const nextIds = new Set(result.users.map((user) => user.id));
        for (const id of users.keys())
          if (!nextIds.has(id)) {
            users.delete(id);
            userSync.write({ type: 'delete', key: id });
          }
        for (const user of result.users) {
          userSync.write({
            type: users.has(user.id) ? 'update' : 'insert',
            value: user,
          });
          users.set(user.id, user);
        }
        const receipt = userSync.commit(lifetime.signal);
        if (receipt !== true) void receipt.catch(() => {});
        publish({
          scope,
          ids: result.items.map((row) => row.id),
          nextCursor: result.nextCursor,
          stats: result.stats,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (!disposed && current === generation && !signal.aborted)
          publish({ ...page, loading: false, error: (error as Error).message });
      }
    },
    async loadOne(id: string, signal?: AbortSignal) {
      await ready;
      const item = await api(`/runs/${id}`, teamRunSchema, {
        signal: signal
          ? AbortSignal.any([lifetime.signal, signal])
          : lifetime.signal,
      });
      if (!signal?.aborted) accept([item]);
      return item;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      pageAbort?.abort();
      rows.clear();
      users.clear();
      pins.clear();
      listeners.clear();
      page = {
        scope: '',
        ids: [],
        nextCursor: null,
        stats: null,
        loading: false,
        error: null,
      };
      await db.cleanup();
    },
  };
}
export type RunsStore = ReturnType<typeof createRunsStore>;
