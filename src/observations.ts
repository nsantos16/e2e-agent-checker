import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isNetworkError, readJson, type NetworkSnapshot } from './network.ts';
import type { BrowserObservation } from './browser-observer.ts';

export function networkFiles(runDir: string): string[] {
  const files = [join(runDir, 'explore/network.json')];
  const attempts = join(runDir, 'codify/attempts');
  if (existsSync(attempts))
    for (const dir of readdirSync(attempts, { withFileTypes: true }))
      if (dir.isDirectory()) files.push(join(attempts, dir.name, 'network.json'));
  if (existsSync(runDir))
    for (const dir of readdirSync(runDir, { withFileTypes: true }))
      if (dir.isDirectory() && dir.name.startsWith('replay-')) files.push(join(runDir, dir.name, 'network.json'));
  return files.filter((p) => existsSync(p) && realpathSync(p).startsWith(realpathSync(runDir) + '/'));
}
export function readNetwork(
  runDir: string,
  options: {
    errorsOnly?: boolean;
    limit?: number;
    stage?: string;
    offset?: number;
    requestId?: string;
  } = {},
) {
  const snapshots = networkFiles(runDir)
    .map((p) => readJson<NetworkSnapshot>(p))
    .filter((s): s is NetworkSnapshot => !!s && s.version === 1 && (!options.stage || s.stage === options.stage));
  const requests = snapshots
    .flatMap((s) => s.requests)
    .filter((r) => (!options.errorsOnly || isNetworkError(r)) && (!options.requestId || r.id === options.requestId))
    .sort((a, b) => b.at.localeCompare(a.at));
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  return {
    capturedStages: snapshots.map((s) => s.stage),
    total: snapshots.reduce((n, s) => n + s.total, 0),
    errorCount: snapshots.reduce((n, s) => n + s.errorCount, 0),
    dropped: snapshots.reduce((n, s) => n + s.dropped, 0),
    matching: requests.length,
    requests: requests.slice(offset, offset + limit),
    nextCursor: offset + limit < requests.length ? offset + limit : null,
  };
}
export function networkSummary(runDir: string, stage?: string) {
  const captured = readNetwork(runDir, { errorsOnly: true, limit: 8, stage });
  return {
    ...captured,
    requests: captured.requests.map(({ id, stage, action, method, url, status, durationMs, failure, requestId, traceId, errorBody }) => ({
      id,
      stage,
      action,
      method,
      url,
      status,
      durationMs,
      failure,
      requestId,
      traceId,
      error: errorBody ? JSON.stringify(errorBody).slice(0, 400) : undefined,
    })),
  };
}
export function readObservation(runDir: string | undefined, active: boolean, errorsOnly = true) {
  if (!runDir)
    return {
      browser: null,
      network: {
        capturedStages: [],
        total: 0,
        errorCount: 0,
        dropped: 0,
        matching: 0,
        requests: [],
      },
    };
  const browser = readJson<BrowserObservation>(join(runDir, 'live/browser.json'));
  const fresh = browser && Date.now() - Date.parse(browser.updatedAt) < 5000;
  return {
    browser: browser
      ? {
          ...browser,
          status: active && browser.status === 'active' ? (fresh ? 'active' : 'stale') : 'closed',
        }
      : null,
    network: readNetwork(runDir, { errorsOnly, limit: 100 }),
  };
}
export function liveFrame(runDir: string) {
  const path = join(runDir, 'live/frame.jpg');
  return existsSync(path) && realpathSync(path).startsWith(realpathSync(runDir) + '/') ? path : undefined;
}
