import type { Network, NetworkRequest } from './types.ts';
export type NetworkFilter = 'all' | 'errors' | 'slow';
export type NetworkFilters = { filter: NetworkFilter; query: string; type: string; stage: string; sort: string };
export const emptyNetwork: Network = {
  requests: [],
  capturedStages: [],
  total: 0,
  errorCount: 0,
  dropped: 0,
  matching: 0,
  nextCursor: null,
};
export const requestFailed = (r: NetworkRequest) => !!r.failure || (r.status ?? 0) >= 400;
export const requestClass = (r: NetworkRequest) =>
  requestFailed(r) ? 'bad' : r.status == null ? 'pending' : r.status >= 300 ? 'redirect' : '';
export const requestDuration = (r: NetworkRequest) =>
  r.durationMs == null
    ? r.incomplete
      ? 'Partial'
      : 'Pending'
    : r.durationMs >= 1000
      ? `${(r.durationMs / 1000).toFixed(2)}s`
      : `${Math.round(r.durationMs)}ms`;
export const requestStatus = (r: NetworkRequest) => (r.failure ? 'ERR' : (r.status ?? '—'));
export const stageLabel = (stage?: string) =>
  stage === 'explore'
    ? 'Explore'
    : stage?.startsWith('codify/')
      ? `Stabilize · ${stage.slice(7)}`
      : stage?.startsWith('replay-')
        ? `Replay · ${stage.slice(7)}`
        : (stage ?? 'Unknown stage');
export function requestName(r: NetworkRequest) {
  try {
    const url = new URL(r.url);
    return { name: url.pathname.split('/').filter(Boolean).pop() || url.hostname, path: url.pathname + url.search, host: url.host };
  } catch {
    return { name: r.url, path: r.url, host: '' };
  }
}
export const timestamp = (r: NetworkRequest) => Date.parse(r.at) || 0;
export function filterRequests(all: NetworkRequest[], state: NetworkFilters) {
  const query = state.query.trim().toLowerCase();
  return all
    .filter(
      (r) =>
        (state.filter !== 'errors' || requestFailed(r)) &&
        (state.filter !== 'slow' || (r.durationMs ?? 0) >= 1000) &&
        (state.type === 'all' ||
          (state.type === 'api'
            ? ['fetch', 'xhr'].includes(r.resourceType)
            : state.type === 'other'
              ? !['fetch', 'xhr', 'document', 'script', 'stylesheet', 'image', 'font'].includes(r.resourceType)
              : r.resourceType === state.type)) &&
        (state.stage === 'all' || r.stage === state.stage) &&
        (!query ||
          `${r.url} ${r.method} ${r.status ?? ''} ${r.requestId ?? ''} ${r.traceId ?? ''} ${r.action ?? ''}`.toLowerCase().includes(query)),
    )
    .sort((a, b) =>
      state.sort === 'slowest'
        ? (b.durationMs ?? -1) - (a.durationMs ?? -1)
        : state.sort === 'oldest'
          ? timestamp(a) - timestamp(b)
          : timestamp(b) - timestamp(a),
    );
}
