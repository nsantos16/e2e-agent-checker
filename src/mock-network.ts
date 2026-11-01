import type { BrowserContext } from 'playwright';
import { isDeepStrictEqual } from 'node:util';
import type { MockInput, MockScenario, MockSuite } from './mock-contract.ts';
import { safeUrl } from './network.ts';

const endpoint = (value: string, base: string) => {
  const u = new URL(value, base);
  return u.origin + u.pathname;
};
export function matchesMock(mock: MockScenario['mocks'][number], request: { method: string; url: string; body?: unknown }, base: string) {
  const u = new URL(request.url);
  const query: Record<string, string[]> = {};
  for (const key of u.searchParams.keys()) query[key] = u.searchParams.getAll(key);
  return (
    mock.method === request.method &&
    endpoint(mock.url, base) === endpoint(request.url, base) &&
    isDeepStrictEqual(query, mock.query) &&
    isDeepStrictEqual(request.body, mock.body)
  );
}
export type MockTraffic = {
  method: string;
  url: string;
  disposition: 'mocked' | 'live' | 'unexpected';
  mockId?: string;
  response?: number;
  reason?: string;
};
export async function installMockNetwork(
  context: BrowserContext,
  scenario: MockScenario,
  suite: MockSuite,
  allowed: MockInput['allowedLiveRequests'],
  base: string,
  save: (rows: MockTraffic[]) => void,
) {
  const counts = new Map<string, number>();
  const rows: MockTraffic[] = [];
  const violations: string[] = [];
  const record = (row: MockTraffic) => {
    if (rows.length < 1000) rows.push(row);
    else if (!violations.includes('Network evidence exceeded 1000 requests')) violations.push('Network evidence exceeded 1000 requests');
    save(rows);
  };
  const blocked = (method: string, url: string, reason: string) => {
    violations.push(`${method} ${safeUrl(url)}: ${reason}`);
    record({ method, url: safeUrl(url), disposition: 'unexpected', reason });
  };
  await context.routeWebSocket(/.*/, (socket) => {
    // A relative HTTP URL rule maps to the frontend's WS origin. This supports
    // explicitly approved dev-server HMR without silently allowing API sockets.
    const live = allowed.find((a) => {
      if (a.method !== 'GET' || !a.resourceTypes.includes('websocket')) return false;
      const target = new URL(a.url, base);
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      const pattern = target.href;
      return pattern.endsWith('*') ? socket.url().startsWith(pattern.slice(0, -1)) : socket.url() === pattern;
    });
    if (live) {
      record({ method: 'WEBSOCKET', url: safeUrl(socket.url()), disposition: 'live', reason: live.reason });
      socket.connectToServer();
    } else {
      blocked('WEBSOCKET', socket.url(), 'No explicit live WebSocket allowance; WebSocket mocks are unsupported');
      socket.close();
    }
  });
  await context.route('**/*', async (route) => {
    const req = route.request();
    let body: unknown = req.postData() ?? undefined;
    if (body !== undefined) {
      try {
        body = req.postDataJSON();
      } catch {
        /* exact text matching */
      }
    }
    const request = { method: req.method(), url: req.url(), body };
    const matching = scenario.mocks.filter((m) => matchesMock(m, request, base));
    if (matching.length === 1) {
      const mock = matching[0],
        index = counts.get(mock.id) ?? 0;
      const response = mock.responses[index];
      if (response) {
        counts.set(mock.id, index + 1);
        record({
          method: request.method,
          url: safeUrl(request.url),
          disposition: 'mocked',
          mockId: mock.id,
          response: index,
        });
        await route.fulfill({
          status: response.status,
          headers: { 'content-type': 'application/json', ...response.headers },
          body: [204, 205, 304].includes(response.status) ? undefined : JSON.stringify(response.body),
        });
        return;
      }
    }
    // A configured endpoint is always protected, even if method/query/body differ,
    // or it appears only in a different scenario. Live allow rules cannot bypass it.
    const protectedEndpoint = suite.scenarios.some((s) => s.mocks.some((m) => endpoint(m.url, base) === endpoint(req.url(), base)));
    const live =
      !protectedEndpoint &&
      !matching.length &&
      allowed.find((a) => {
        const pattern = new URL(a.url, base).href;
        return (
          a.method === req.method() &&
          a.resourceTypes.includes(req.resourceType() as any) &&
          (pattern.endsWith('*') ? req.url().startsWith(pattern.slice(0, -1)) : req.url() === pattern)
        );
      });
    if (live) {
      record({
        method: req.method(),
        url: safeUrl(req.url()),
        disposition: 'live',
        reason: live.reason,
      });
      // A live redirect is not permission for an unlisted destination.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      if (response.status() >= 300 && response.status() < 400) {
        blocked(req.method(), req.url(), 'Live redirects require a direct allowed URL');
        await route.abort('blockedbyclient');
      } else await route.fulfill({ response });
      return;
    }
    blocked(
      req.method(),
      req.url(),
      matching.length > 1 ? 'Ambiguous mocks' : matching.length ? 'Response sequence exhausted' : 'No matching mock or live allowance',
    );
    await route.abort('blockedbyclient');
  });
  return {
    assertComplete() {
      const missing = scenario.mocks.flatMap((m) =>
        (counts.get(m.id) ?? 0) !== m.responses.length
          ? [`${m.id}: consumed ${counts.get(m.id) ?? 0}/${m.responses.length} responses`]
          : [],
      );
      if (violations.length || missing.length) throw new Error(`MOCK_NETWORK_FAILED:\n${[...violations, ...missing].join('\n')}`);
    },
  };
}
