import {
  DbClient,
  collectionOptions,
  type SyncConfig,
} from '@tanstack/react-db';
import {
  caseDraftSchema,
  casePageSchema,
  teamCaseSchema,
  type TeamCase,
  type CaseDraft,
} from '../contracts.ts';
import type { TeamApi } from './api.ts';

type Sync = Parameters<SyncConfig<TeamCase, string>['sync']>[0];
type PageState = {
  ids: string[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
};
// One instance belongs to one authenticated identity. No global cache or Query adapter.
export function createCasesStore(api: TeamApi, identityKey: string) {
  const db = new DbClient();
  const lifetime = new AbortController();
  let sync: Sync;
  let disposed = false;
  let generation = 0;
  let pageAbort: AbortController | undefined;
  let pageScope = '';
  let page: PageState = {
    ids: [],
    nextCursor: null,
    loading: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  const rows = new Map<string, TeamCase>();
  const pinned = new Set<string>();
  const pending = new Set<string>();
  const publish = (next: PageState) => {
    if (!disposed) {
      page = next;
      listeners.forEach((fn) => fn());
    }
  };
  const accept = (items: TeamCase[]) => {
    if (disposed) return;
    sync.begin();
    for (const item of items) {
      const old = rows.get(item.id);
      if (!old || item.revision > old.revision) {
        rows.set(item.id, item);
        sync.write({ type: old ? 'update' : 'insert', value: item });
      }
    }
    const retained = new Set([
      ...page.ids,
      ...pinned,
      ...pending,
      ...items.map((item) => item.id),
    ]);
    for (const id of rows.keys()) {
      if (rows.size <= 250) break;
      if (!retained.has(id)) {
        rows.delete(id);
        sync.write({ type: 'delete', key: id });
      }
    }
    // Do not await this receipt inside a mutation: DB publishes it at settlement.
    const receipt = sync.commit(lifetime.signal);
    if (receipt !== true)
      void receipt.catch(() => {
        /* Lifetime cancellation discards the workspace. */
      });
  };
  const collection = db.collection(
    collectionOptions({
      id: `cases:${identityKey}`,
      schema: teamCaseSchema,
      getKey: (row) => row.id,
      sync: {
        sync(params) {
          sync = params;
          params.markReady();
          return () => {};
        },
      },
      onUpdate: async ({ transaction }) => {
        if (disposed) throw new Error('This workspace is closed.');
        if (transaction.mutations.length !== 1)
          throw new Error('Edit one case at a time.');
        const mutation = transaction.mutations[0];
        const draft = caseDraftSchema.parse(
          Object.fromEntries(
            Object.keys(caseDraftSchema.shape).map((key) => [
              key,
              mutation.modified[key as keyof TeamCase],
            ]),
          ),
        );
        const updated = await api(
          `/cases/${mutation.original.id}`,
          teamCaseSchema,
          {
            method: 'PATCH',
            signal: lifetime.signal,
            body: { expectedRevision: mutation.original.revision, data: draft },
          },
        );
        if (disposed) throw new Error('This workspace is closed.');
        accept([updated]);
      },
    }),
  );
  const ready = collection.preload();
  return {
    db,
    collection,
    pin(id: string) {
      pinned.add(id);
      return () => {
        pinned.delete(id);
      };
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => page,
    async loadPage(search: string, after?: string) {
      const current = ++generation;
      pageAbort?.abort();
      pageAbort = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, pageAbort.signal]);
      const scope = `${search}:${after ?? ''}`;
      publish({
        ...(scope === pageScope ? page : { ids: [], nextCursor: null }),
        loading: true,
        error: null,
      });
      pageScope = scope;
      try {
        await ready;
        const params = new URLSearchParams({
          search,
          limit: '25',
          ...(after ? { after } : {}),
        });
        const result = await api(`/cases?${params}`, casePageSchema, {
          signal,
        });
        if (disposed || current !== generation) return;
        accept(result.items);
        publish({
          ids: result.items.map((item) => item.id),
          nextCursor: result.nextCursor,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (!disposed && current === generation && !signal.aborted)
          publish({
            ...page,
            loading: false,
            error: String((error as Error).message),
          });
      }
    },
    async loadOne(id: string) {
      await ready;
      const item = await api(`/cases/${id}`, teamCaseSchema, {
        signal: lifetime.signal,
      });
      accept([item]);
      return item;
    },
    async create(id: string, data: CaseDraft) {
      await ready;
      const item = await api('/cases', teamCaseSchema, {
        method: 'POST',
        body: { id, data },
        signal: lifetime.signal,
      });
      if (disposed) throw new Error('This workspace is closed.');
      accept([item]);
      return item;
    },
    async update(id: string, data: CaseDraft, expectedRevision: number) {
      await ready;
      if (disposed) throw new Error('This workspace is closed.');
      if (rows.get(id)?.revision !== expectedRevision)
        throw new Error('This case changed. Reload and reapply your edits.');
      if (pending.has(id)) throw new Error('This case is already being saved.');
      pending.add(id);
      try {
        const transaction = collection.update(id, (draft) =>
          Object.assign(draft, data),
        );
        await transaction.when('settled');
      } finally {
        pending.delete(id);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      pageAbort?.abort();
      rows.clear();
      pinned.clear();
      pending.clear();
      page = { ids: [], nextCursor: null, loading: false, error: null };
      listeners.clear();
      await db.cleanup();
    },
  };
}
export type CasesStore = ReturnType<typeof createCasesStore>;
