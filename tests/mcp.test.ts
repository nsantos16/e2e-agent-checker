import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP schemas, structured responses, operational errors, and batch forwarding', async () => {
  const requests: any[] = [];
  const app = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/config') return res.end('{}');
    if (req.url === '/api/providers')
      return res.end(
        JSON.stringify([
          { id: 'codex', name: 'Codex', installed: true, auth: 'subscription', ready: true, models: [{ id: 'model', name: 'Model' }] },
        ]),
      );
    if (req.url?.startsWith('/api/jobs/one/network?'))
      return res.end(
        JSON.stringify({
          total: 1,
          errorCount: 1,
          dropped: 0,
          matching: 1,
          capturedStages: ['explore'],
          requests: [{ id: 'request-1', method: 'GET', url: 'https://example.test/failure', status: 503, requestId: 'req-1' }],
        }),
      );
    if (req.url === '/api/jobs' && req.method === 'POST') return res.end('["one","two"]');
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 'NOT_FOUND', error: 'unknown job' }));
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const port = (app.address() as any).port;
  const client = new Client({ name: 'contract-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['src/mcp-server.ts'],
      env: { ...process.env, E2E_APP_PORT: String(port) } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    assert.ok(tools.every((t) => t.outputSchema));
    const result = await client.callTool({ name: 'list_providers', arguments: {} });
    assert.equal((result.structuredContent as any).data.providers[0].auth, 'subscription');
    const failed = await client.callTool({ name: 'get_job', arguments: { jobId: 'missing' } });
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed.content), /NOT_FOUND/);
    const batch = await client.callTool({
      name: 'verify_cases',
      arguments: {
        worktreePath: '/checkout',
        cases: [{ project: 'TEST', id: 1 }],
        targets: [{ provider: 'codex', model: 'model' }],
        idempotencyKey: 'retry',
      },
    });
    assert.deepEqual((batch.structuredContent as any).data.jobIds, ['one', 'two']);
    assert.equal(requests.at(-1).body.targets[0].authMode, 'subscription');
    assert.equal(requests.at(-1).body.idempotencyKey, 'retry');
    const network = await client.callTool({ name: 'get_network', arguments: { jobId: 'one', stage: 'explore' } });
    assert.equal((network.structuredContent as any).data.requests[0].status, 503);
    assert.match(requests.at(-1).path, /errorsOnly=1/);
    assert.match(requests.at(-1).path, /stage=explore/);
    const publish = await client.callTool({
      name: 'attach_to_pr',
      arguments: { jobId: 'one', pr: 'https://github.com/example/repo/pull/1' },
    });
    assert.equal(publish.isError, true);
  } finally {
    await client.close();
    await new Promise<void>((r) => app.close(() => r()));
  }
});
