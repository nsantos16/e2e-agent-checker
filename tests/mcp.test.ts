import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP schemas, structured responses, operational errors, and batch forwarding', async () => {
  const requests: any[] = [];
  let revision = 'one';
  let status = 'running';
  const app = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/jobs?') && new URL(req.url, 'http://test').searchParams.get('ids') === 'active')
      return res.end(
        JSON.stringify([
          {
            id: 'active',
            project: 'TEST',
            caseId: 1,
            status,
            terminal: status === 'done',
            revision,
            viewerUrl: 'http://localhost/?job=active',
          },
        ]),
      );
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
    assert.equal(tools.length, 25);
    assert.ok(tools.every((t) => t.outputSchema));
    assert.equal(tools.find((t) => t.name === 'get_job')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'verify_case')?.annotations?.readOnlyHint, false);
    assert.match(client.getInstructions() ?? '', /wait_jobs/);
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
        confirmationReplay: true,
        forceFresh: true,
        buildId: 'new-build',
      },
    });
    assert.deepEqual((batch.structuredContent as any).data.jobIds, ['one', 'two']);
    assert.equal(requests.at(-1).body.targets[0].authMode, 'subscription');
    assert.equal(requests.at(-1).body.idempotencyKey, 'retry');
    assert.equal(requests.at(-1).body.confirmationReplay, true);
    assert.equal(requests.at(-1).body.forceFresh, true);
    assert.equal(requests.at(-1).body.buildId, 'new-build');
    const nativeRun = await client.callTool({
      name: 'verify_case',
      arguments: { project: 'LOCAL', caseId: 8, worktreePath: '/checkout', target: { provider: 'codex', model: 'model' } },
    });
    assert.equal(nativeRun.isError, undefined);
    assert.deepEqual(requests.at(-1).body.cases, [{ project: 'LOCAL', id: 8 }]);
    assert.equal(requests.at(-1).body.forceFresh, false);
    assert.match(client.getInstructions() ?? '', /no model calls or provider preflight/);
    const forced = await client.callTool({ name: 'verify_case', arguments: { project: 'LOCAL', caseId: 8, forceFresh: true } });
    assert.equal(forced.isError, undefined);
    assert.equal(requests.at(-1).body.forceFresh, true);
    assert.equal(tools.find((t) => t.name === 'create_case')?.annotations?.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === 'delete_case')?.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'sync_case')?.annotations?.openWorldHint, true);
    const network = await client.callTool({ name: 'get_network', arguments: { jobId: 'one', stage: 'explore' } });
    assert.equal((network.structuredContent as any).data.requests[0].status, 503);
    assert.match(requests.at(-1).path, /errorsOnly=1/);
    assert.match(requests.at(-1).path, /stage=explore/);
    const before = requests.length;
    const idle = await client.callTool({ name: 'wait_jobs', arguments: { jobIds: ['active'], revisions: { active: 'one' }, waitMs: 100 } });
    assert.deepEqual((idle.structuredContent as any).data.jobs, []);
    assert.equal((idle.structuredContent as any).data.timedOut, true);
    assert.deepEqual((idle.structuredContent as any).data.pendingJobIds, ['active']);
    assert.ok(requests.length - before <= 4, 'bounded polling');
    setTimeout(() => {
      revision = 'two';
    }, 50);
    const changed = await client.callTool({
      name: 'wait_jobs',
      arguments: { jobIds: ['active'], revisions: { active: 'one' }, waitMs: 1500 },
    });
    assert.equal((changed.structuredContent as any).data.jobs[0].revision, 'two');
    assert.equal((changed.structuredContent as any).data.timedOut, false);
    setTimeout(() => {
      status = 'done';
      revision = 'three';
    }, 50);
    const completed = await client.callTool({ name: 'wait_jobs', arguments: { jobIds: ['active'], waitMs: 1500 } });
    assert.deepEqual((completed.structuredContent as any).data.pendingJobIds, []);
    assert.equal((completed.structuredContent as any).data.jobs[0].terminal, true);
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
