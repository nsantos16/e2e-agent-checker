import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext, Request, Response } from 'playwright';

const secretKey = /password|passwd|secret|token|authorization|cookie|api[-_]?key|session|credential/i;
export const redactText = (value: string, options: { preserveCodeDelimiters?: boolean } = {}) =>
  value
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(
      options.preserveCodeDelimiters
        ? /((?:password|secret|token|api[-_]?key|authorization|cookie)\s*[=:]\s*)[^\s&,;"'<>`\\)]+/gi
        : /((?:password|secret|token|api[-_]?key|authorization|cookie)\s*[=:]\s*)[^\s&,;]+/gi,
      '$1[redacted]',
    );
export const scrubText = (value: string) => redactText(value).slice(0, 2000);
export function safeUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return url.protocol;
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
    return scrubText(url.toString());
  } catch {
    return '[invalid URL]';
  }
}
// Only diagnostic fields from JSON error responses are retained. Never request bodies or auth headers.
export function errorBody(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => errorBody(v, depth + 1));
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !secretKey.test(key) &&
          /^(message|error|errors|code|status|type|title|detail|details|reason|field|path|requestId|traceId)$/i.test(key),
      )
      .slice(0, 20)
      .map(([key, v]) => [key, errorBody(v, depth + 1)]),
  );
}
export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
export type NetworkEntry = {
  id: string;
  at: string;
  stage: string;
  action?: string;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  durationMs: number | null;
  incomplete?: boolean;
  failure?: string;
  requestId?: string;
  traceId?: string;
  contentType?: string;
  errorBody?: unknown;
  bodyNote?: string;
  redirectedFrom?: string;
};
export type NetworkSnapshot = {
  version: 1;
  stage: string;
  updatedAt: string;
  total: number;
  errorCount: number;
  dropped: number;
  requests: NetworkEntry[];
};
export const isNetworkError = (r: NetworkEntry) => !!r.failure || (r.status ?? 0) >= 400;

export function collectNetwork(context: BrowserContext, options: { path: string; stage: string; actionPath: string; maxEntries?: number }) {
  const entries: NetworkEntry[] = [],
    byRequest = new WeakMap<Request, NetworkEntry>(),
    pending = new Set<Promise<void>>();
  const max = options.maxEntries ?? 1000;
  let total = 0,
    dropped = 0,
    errorCount = 0,
    closed = false,
    dirty = true;
  const errors = new WeakSet<NetworkEntry>();
  const markError = (row: NetworkEntry) => {
    if (isNetworkError(row) && !errors.has(row)) {
      errors.add(row);
      errorCount++;
    }
  };
  const flush = () => {
    if (!dirty) return;
    atomicJson(options.path, {
      version: 1,
      stage: options.stage,
      updatedAt: new Date().toISOString(),
      total,
      errorCount,
      dropped,
      requests: entries,
    } satisfies NetworkSnapshot);
    dirty = false;
  };
  const request = (r: Request) => {
    const row: NetworkEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      stage: options.stage,
      action: readJson<{ name: string }>(options.actionPath)?.name,
      method: r.method(),
      url: safeUrl(r.url()),
      resourceType: r.resourceType(),
      status: null,
      durationMs: null,
      ...(r.redirectedFrom() ? { redirectedFrom: safeUrl(r.redirectedFrom()!.url()) } : {}),
    };
    dirty = true;
    total++;
    byRequest.set(r, row);
    entries.push(row);
    if (entries.length > max) {
      const clean = entries.findIndex((e) => !isNetworkError(e));
      entries.splice(clean < 0 ? 0 : clean, 1);
      dropped++;
    }
  };
  const finish = (r: Request) => {
    const row = byRequest.get(r);
    if (!row) return;
    dirty = true;
    row.durationMs = Math.max(0, Date.now() - Date.parse(row.at));
    if (r.failure()) row.failure = scrubText(r.failure()!.errorText);
    markError(row);
    if (isNetworkError(row)) flush();
  };
  const response = (res: Response) => {
    const row = byRequest.get(res.request());
    if (!row) return;
    dirty = true;
    row.status = res.status();
    const headers = res.headers();
    row.contentType = headers['content-type']?.slice(0, 150);
    row.requestId = scrubText(headers['x-request-id'] ?? headers['request-id'] ?? '').slice(0, 200) || undefined;
    row.traceId = scrubText(headers['traceparent'] ?? headers['x-amzn-trace-id'] ?? '').slice(0, 200) || undefined;
    markError(row);
    if (row.status < 400) return;
    // Skip unbounded/compressed/unknown-size bodies instead of loading an arbitrary response into memory.
    const size = Number(headers['content-length']);
    if (!row.contentType?.includes('json') || !Number.isFinite(size) || size <= 0 || size > 32_768 || headers['content-encoding']) {
      row.bodyNote = 'Body omitted (non-JSON, unknown size, compressed, or over 32 KiB).';
      flush();
      return;
    }
    const task = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const body = await Promise.race([
          res.body(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 2000);
          }),
        ]);
        if (closed) return;
        if (body.length > 32_768) {
          row.bodyNote = 'Body exceeded limit.';
          return;
        }
        const cleaned = errorBody(JSON.parse(body.toString())),
          serialized = JSON.stringify(cleaned);
        row.errorBody = serialized.length > 4096 ? serialized.slice(0, 4096) + '… [truncated]' : cleaned;
        dirty = true;
      } catch {
        if (!closed) {
          row.bodyNote = 'Response body unavailable.';
          dirty = true;
        }
      } finally {
        clearTimeout(timer);
      }
    })();
    flush();
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
      flush();
    });
  };
  context.on('request', request);
  context.on('response', response);
  context.on('requestfinished', finish);
  context.on('requestfailed', finish);
  const timer = setInterval(flush, 500);
  timer.unref();
  flush();
  return {
    flush,
    async close() {
      if (closed) return;
      clearInterval(timer);
      await Promise.allSettled([...pending]);
      context.off('request', request);
      context.off('response', response);
      context.off('requestfinished', finish);
      context.off('requestfailed', finish);
      await Promise.allSettled([...pending]);
      closed = true;
      for (const row of entries)
        if (row.durationMs === null) {
          row.incomplete = true;
          dirty = true;
        }
      flush();
    },
  };
}
