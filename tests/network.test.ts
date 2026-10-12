import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext, Request } from 'playwright';
import { atomicJson, collectNetwork, errorBody, readJson, safeUrl, type NetworkSnapshot } from '../src/network.ts';
import { readNetwork, readObservation } from '../src/observations.ts';

test('network diagnostics redact credentials, query values, and non-diagnostic fields', () => {
  const url = safeUrl('https://user:password@example.test/api?token=private&search=customer#secret');
  assert(!url.includes('private') && !url.includes('customer') && !url.includes('password'));
  assert.equal(safeUrl('data:text/plain,private'), 'data:');
  assert.deepEqual(
    errorBody({
      message: 'Bearer private-token',
      code: 'INVALID',
      token: 'secret',
      user: { email: 'private@example.test' },
      details: { password: 'private', field: 'name', reason: 'missing' },
    }),
    { message: 'Bearer [redacted]', code: 'INVALID', details: { field: 'name', reason: 'missing' } },
  );
});

test('network capture distinguishes HTTP/transport failures and retains bounded evidence with stage/action correlation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-network-'));
  const context = new EventEmitter() as unknown as BrowserContext;
  const emit = (name: string, arg: unknown) => (context as unknown as EventEmitter).emit(name, arg);
  const path = join(dir, 'explore/network.json'),
    actionPath = join(dir, 'live/action.json');
  atomicJson(actionPath, { name: 'browser_click' });
  const recorder = collectNetwork(context, { path, stage: 'explore', actionPath, maxEntries: 2 });
  const request = (url: string, failure?: string) =>
    ({
      method: () => 'GET',
      url: () => url,
      resourceType: () => 'fetch',
      redirectedFrom: () => null,
      failure: () => (failure ? { errorText: failure } : null),
    }) as unknown as Request;
  try {
    const bad = request('https://example.test/api?secret=hidden');
    emit('request', bad);
    const body = JSON.stringify({ code: 'UPSTREAM_DOWN', message: 'Service unavailable', password: 'hidden' });
    emit('response', {
      request: () => bad,
      status: () => 503,
      headers: () => ({
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-request-id': 'req-123',
        'set-cookie': 'secret-cookie',
      }),
      body: async () => Buffer.from(body),
    });
    emit('requestfinished', bad);
    const broken = request('https://example.test/abort', 'net::ERR_CONNECTION_RESET');
    emit('request', broken);
    emit('requestfailed', broken);
    const good = request('https://example.test/ok');
    emit('request', good);
    emit('requestfinished', good);
    await recorder.close();
    const snapshot = readJson<NetworkSnapshot>(path)!;
    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.errorCount, 2);
    assert.equal(snapshot.dropped, 1);
    assert.equal(snapshot.requests.length, 2);
    assert.equal(snapshot.requests[0].action, 'browser_click');
    assert.equal(snapshot.requests[0].status, 503);
    assert.equal(snapshot.requests[0].requestId, 'req-123');
    assert.deepEqual(snapshot.requests[0].errorBody, { code: 'UPSTREAM_DOWN', message: 'Service unavailable' });
    assert.equal(snapshot.requests[1].failure, 'net::ERR_CONNECTION_RESET');
    assert(!JSON.stringify(snapshot).includes('hidden') && !JSON.stringify(snapshot).includes('secret-cookie'));
    assert.equal(readNetwork(dir, { errorsOnly: true, limit: 1 }).requests.length, 1);
    assert.deepEqual(readNetwork(dir, { stage: 'missing' }).capturedStages, []);
    atomicJson(join(dir, 'live/browser.json'), { stage: 'explore', status: 'active', updatedAt: new Date().toISOString() });
    assert.equal(readObservation(dir, true).browser?.status, 'active');
    assert.equal(readObservation(dir, false).browser?.status, 'closed');
    atomicJson(join(dir, 'live/browser.json'), { stage: 'explore', status: 'active', updatedAt: '2000-01-01T00:00:00Z' });
    assert.equal(readObservation(dir, true).browser?.status, 'stale');
  } finally {
    await recorder.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
