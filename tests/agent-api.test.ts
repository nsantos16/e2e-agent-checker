import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { jobSummary, readEvidence, artifactPath } from '../src/agent-view.ts';
import { atomicJson } from '../src/network.ts';
import type { Job } from '../src/jobs.ts';
import { CaseCatalog } from '../src/cases.ts';
import { SettingsStore } from '../src/settings.ts';

const jobIds = (jobs: { id: string }[]) => jobs.map((job) => job.id);

const fixture = (runDir: string): Job => ({
  id: 'agent-test',
  project: 'DEMO',
  caseId: 6003,
  status: 'done',
  outcome: 'fail',
  role: 'test',
  worktree: '/test/worktree',
  createdAt: '2026-01-01T00:00:00Z',
  runDir,
  log: Array.from({ length: 80 }, (_, i) => `${i} ${'long diagnostic log '.repeat(40)}`),
  steps: [{ position: 1, verdict: 'fail', evidence: 'API rejected the request' }],
  replay: { status: 'failed', failedStep: 'Submit', error: 'Expected success' },
});
function populate(dir: string) {
  mkdirSync(join(dir, 'explore'), { recursive: true });
  mkdirSync(join(dir, 'codify'), { recursive: true });
  writeFileSync(join(dir, 'codify/DEMO-6003.spec.ts'), 'spec contents');
  atomicJson(join(dir, 'pricing.json'), { id: 'test-snapshot', basis: 'standard-api', models: {} });
  atomicJson(join(dir, 'usage.json'), { usage: { estimatedApiCostUsd: 0.0123, pricingSnapshotId: 'test-snapshot' } });
  atomicJson(join(dir, 'explore/case.json'), { project: 'LOCAL', id: 1, title: 'Original case snapshot' });
  atomicJson(join(dir, 'explore/report.json'), { verdict: 'fail', notes: 'report '.repeat(1000) });
  atomicJson(join(dir, 'explore/network.json'), {
    version: 1,
    stage: 'explore',
    total: 7,
    errorCount: 6,
    dropped: 0,
    requests: Array.from({ length: 7 }, (_, i) => ({
      id: `row-${i}`,
      at: `2026-01-01T00:00:0${i}Z`,
      stage: 'explore',
      method: 'GET',
      url: `https://example.test/api/${i}`,
      status: i === 0 ? 200 : 503,
      requestId: `correlation-${i}`,
      errorBody: { message: 'Detailed diagnostic response' },
    })),
  });
  atomicJson(join(dir, 'live/browser.json'), { stage: 'replay', status: 'closed', updatedAt: '2026-01-01T00:00:00Z', frameAt: 'frame-1' });
  writeFileSync(join(dir, 'live/frame.jpg'), Buffer.from([255, 216, 255, 217]));
}

test('agent summaries stay small; evidence is paged and constrained to the job directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-agent-'));
  try {
    populate(dir);
    const job = fixture(dir),
      compact = jobSummary(job, 'http://localhost:4100');
    assert.equal(compact.terminal, true);
    assert.equal(compact.outcome, 'fail');
    assert.equal(compact.next, 'get_evidence');
    assert.equal(compact.network?.failures.length, 3);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(job).length / 10);
    assert.equal(compact.revision, jobSummary(job, 'http://localhost:4100').revision);
    assert.notEqual(compact.revision, jobSummary({ ...job, status: 'failed' }, 'http://localhost:4100').revision);
    assert.equal('log' in compact, false);
    assert.match(readEvidence(job, '', { artifact: 'case' }).text!, /Original case snapshot/);
    const evidence = readEvidence(job, 'http://localhost:4100');
    assert.equal(evidence.failedSteps?.[0].position, 1);
    const first = readEvidence(job, '', { artifact: 'report', limit: 20 });
    const next = readEvidence(job, '', { artifact: 'report', offset: first.nextOffset!, limit: 20 });
    assert.equal(first.text!.length, 20);
    assert.equal(next.offset, 20);
    const outside = join(dir, '../outside-' + dir.split('/').at(-1));
    writeFileSync(outside, 'must not be exposed');
    symlinkSync(outside, join(dir, 'pr-comment.md'));
    try {
      assert.equal(artifactPath(job, 'comment'), undefined);
      assert.throws(() => readEvidence(job, '', { artifact: 'comment' }), /not been captured/);
      assert.throws(() => readEvidence(job, '', { artifact: '../../outside' }), /artifact URL/);
    } finally {
      rmSync(outside);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real local API and stdio MCP expose compact jobs, selected diagnostics, paged evidence and frame deltas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-api-'));
  populate(dir);
  const jobs = join(dir, 'jobs.json');
  const reusedDir = join(dir, 'reused');
  populate(reusedDir);
  const reused: Job = {
    ...fixture(reusedDir),
    id: 'reused',
    steps: [{ position: 1, verdict: 'fail', evidence: 'Fresh regression' }],
    specSelection: { mode: 'reuse', reason: 'compatible', sourceRun: dir },
    historicalExploration: { sourceRun: dir, verdict: 'pass' },
    replay: { status: 'failed', results: join(reusedDir, 'results.json') },
  };
  atomicJson(join(reusedDir, 'verification.json'), { caseId: 6003, verdict: 'fail', steps: reused.steps, source: 'replay' });
  atomicJson(join(reusedDir, 'historical/explore-report.json'), {
    caseId: 6003,
    verdict: 'pass',
    steps: [],
    provenance: { historical: true, sourceRun: dir },
  });
  atomicJson(join(reusedDir, 'historical/manifest.json'), { version: 1 });
  atomicJson(join(reusedDir, 'summary.json'), { specSelection: reused.specSelection });
  atomicJson(join(reusedDir, 'results.json'), { suites: [] });
  writeFileSync(jobs, JSON.stringify([fixture(dir), reused]));
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const env = {
    ...process.env,
    E2E_APP_PORT: String(port),
    E2E_APP_OPEN: '0',
    E2E_JOBS_PATH: jobs,
    E2E_CASES_PATH: join(dir, 'cases.json'),
    E2E_ENVIRONMENTS_PATH: join(dir, 'environments.json'),
    E2E_SETTINGS_PATH: join(dir, 'settings.json'),
  } as Record<string, string>;
  let app = spawn(process.execPath, ['src/app/server.ts'], { env, stdio: 'ignore' });
  let closed = new Promise<void>((r) => app.once('exit', () => r()));
  const client = new Client({ name: 'real-api-test', version: '1' });
  const base = `http://127.0.0.1:${port}`;
  const waitForApp = async () => {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await fetch(base + '/api/config').then(
        (r) => r.ok,
        () => false,
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, 'test server started');
  };
  try {
    await waitForApp();
    const settings = await (await fetch(base + '/api/settings')).json();
    assert.equal(settings.runCacheAfterDays, null);
    const invalidSettings = await fetch(base + '/api/settings', {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: settings.revision, settings: { runCacheAfterDays: 0 } }),
    });
    assert.equal(invalidSettings.status, 400);
    const savedSettings = await (
      await fetch(base + '/api/settings', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: settings.revision, settings: { runCacheAfterDays: null } }),
      })
    ).json();
    assert.notEqual(savedSettings.revision, settings.revision);
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /id="root"/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    assert.equal(assets.length, 2, 'React entry loads bundled JavaScript and CSS');
    for (const asset of assets) {
      const response = await fetch(base + asset);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control') ?? '', /immutable/);
      assert.match(response.headers.get('content-type') ?? '', asset.endsWith('.js') ? /javascript/ : /css/);
      assert.ok((await response.text()).length > 100);
    }
    assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
    assert.equal((await fetch(base + '/assets/%2e%2e%2fpackage.json')).status, 404);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp-server.ts'], env, stderr: 'pipe' }));
    const call = async (name: string, args: object) => {
      const response = await client.callTool({ name, arguments: args as Record<string, unknown> });
      assert.ok(!response.isError, JSON.stringify(response.content));
      return (response.structuredContent as any).data;
    };
    const voice = await call('get_voice_settings', {});
    assert.equal(voice.settings.enabled, false);
    assert.equal(voice.speech.status, 'not-configured');
    const { revision: voiceRevision, speechCredentialRef: unusedRef, ...voiceOptions } = voice.settings;
    const voiceSaved = await call('save_voice_settings', {
      expectedRevision: voiceRevision,
      options: { ...voiceOptions, voice: 'cedar' },
      speechCredentialRef: 'env://OFFLINE_SPEECH_FIXTURE',
    });
    const httpVoice = await (await fetch(base + '/api/settings/voice')).json();
    assert.deepEqual(httpVoice, voiceSaved, 'UI HTTP and MCP use the same persisted settings');
    const voiceHttpSaved = await (
      await fetch(base + '/api/settings/voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: voiceSaved.settings.revision,
          options: voiceOptions,
          speechCredentialRef: null,
        }),
      })
    ).json();
    assert.deepEqual(await call('get_voice_settings', {}), voiceHttpSaved);
    const rawVoiceSecret = await client.callTool({
      name: 'save_voice_settings',
      arguments: {
        expectedRevision: voiceHttpSaved.settings.revision,
        options: voiceOptions,
        speechCredentialRef: 'raw-api-key',
      },
    });
    assert.equal(rawVoiceSecret.isError, true);
    const sessions = await call('list_sessions', {});
    assert.deepEqual(sessions.sessions.find((s: any) => s.id === 'agent-test')?.jobIds, ['agent-test']);
    const session = await call('create_session', {
      title: 'PR regression proof',
      jobIds: ['agent-test'],
    });
    const summary = await call('get_session_summary', {
      sessionId: session.id,
    });
    assert.equal(summary.counts.fail, 1);
    assert.match(summary.markdown, /API rejected the request/);
    assert.match(summary.markdown, /Failures, blocked and incomplete/);
    const again = await (await fetch(base + `/api/sessions/${session.id}/summary`)).json();
    assert.equal(again.revision, summary.revision);
    assert.equal(again.markdown, summary.markdown, 'UI HTTP and MCP expose one standard format');
    const markdown = await fetch(base + `/api/sessions/${session.id}/summary?format=markdown`);
    assert.equal(await markdown.text(), summary.markdown);
    assert.equal((await call('get_demos', { jobId: 'agent-test' })).demos.length, 0, 'summary reads never start narration');
    const noPublish = await fetch(base + '/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        pr: 'https://github.com/test/example/pull/1',
      }),
    });
    assert.equal(noPublish.status, 400, 'publication is always explicit');
    const pricingEvidence = await call('get_evidence', { jobId: 'agent-test', artifact: 'pricing' });
    assert.match(pricingEvidence.text, /test-snapshot/);
    const usageEvidence = await call('get_evidence', { jobId: 'agent-test', artifact: 'usage' });
    assert.match(usageEvidence.text, /0.0123/);
    const pricingDownload = await fetch(base + '/api/jobs/agent-test/artifacts/pricing');
    assert.equal(pricingDownload.status, 200);
    assert.equal((await pricingDownload.json()).id, 'test-snapshot');
    const definition = {
      id: 'staging',
      name: 'Staging',
      kind: 'hosted',
      baseUrl: 'https://staging.example.test',
      users: [{ id: 'qa', name: 'QA', usernameRef: 'env://QA_USERNAME', passwordRef: 'env://QA_PASSWORD' }],
    };
    const environment = await call('save_environment', { environment: definition });
    const catalog = await call('list_environments', {});
    assert.equal(catalog.environments.find((e: any) => e.id === 'staging').users[0].passwordRef, undefined);
    const editable = await call('list_environments', { detail: true });
    assert.equal(editable.environments.find((e: any) => e.id === 'staging').users[0].passwordRef, 'env://QA_PASSWORD');
    const staleEnvironment = await client.callTool({
      name: 'save_environment',
      arguments: { environment: definition, expectedRevision: 'stale' },
    });
    assert.equal(staleEnvironment.isError, true);
    const rawSecret = await client.callTool({
      name: 'save_environment',
      arguments: {
        environment: { ...definition, users: [{ ...definition.users[0], passwordRef: 'not-a-reference' }] },
        expectedRevision: environment.revision,
      },
    });
    assert.equal(rawSecret.isError, true);
    const deletedEnvironment = await call('delete_environment', { environmentId: 'staging', expectedRevision: environment.revision });
    assert.equal(deletedEnvironment.deleted, true);
    const created = await call('create_case', { title: 'Native case', idempotencyKey: 'native-1' });
    assert.equal(created.project, 'LOCAL');
    assert.equal(created.status, 'draft');
    assert.equal(created.steps, 0, 'mutation acknowledgment does not echo full steps');
    assert.equal((await call('create_case', { title: 'Native case', idempotencyKey: 'native-1' })).id, created.id);
    const full = await call('get_case', { project: 'LOCAL', caseId: created.id });
    assert.equal(full.source.kind, 'local');
    const activated = await call('update_case', {
      project: 'LOCAL',
      caseId: full.id,
      expectedRevision: full.revision,
      changes: { status: 'active', tags: ['smoke'], steps: [{ action: 'Open page', expected_result: 'Heading visible' }] },
    });
    const stale = await client.callTool({
      name: 'update_case',
      arguments: { project: 'LOCAL', caseId: full.id, expectedRevision: full.revision, changes: { title: 'Stale edit' } },
    });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale.content), /REVISION_CONFLICT/);
    const staleRemoval = await fetch(base + `/api/cases/LOCAL/${full.id}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: full.revision }),
    });
    assert.equal(staleRemoval.status, 409, 'sidebar archival also checks the displayed revision');
    assert.equal((await call('list_cases', { project: 'LOCAL', tag: 'smoke', status: 'active' })).total, 1);
    const archived = await call('delete_case', { project: 'LOCAL', caseId: full.id, expectedRevision: activated.revision });
    assert.equal((await call('list_cases', { project: 'LOCAL' })).total, 0);
    assert.equal((await call('list_cases', { project: 'LOCAL', status: 'archived' })).total, 1);
    assert.equal(
      (await call('get_case', { project: 'LOCAL', qaseCaseId: full.id })).status,
      'archived',
      'legacy ID alias remains supported',
    );
    await call('update_case', { project: 'LOCAL', caseId: full.id, expectedRevision: archived.revision, changes: { status: 'active' } });
    const ambiguous = await client.callTool({
      name: 'get_case',
      arguments: { project: 'LOCAL', caseId: full.id, qaseCaseId: full.id + 1 },
    });
    assert.equal(ambiguous.isError, true);
    const crossOrigin = await fetch(base + '/api/cases/create', {
      method: 'POST',
      headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Forbidden' }),
    });
    assert.equal(crossOrigin.status, 403);
    const remove = () => fetch(base + '/api/jobs/agent-test/remove', { method: 'POST', body: '{}' });
    const removedResponse = await remove();
    assert.equal(removedResponse.status, 200);
    const removed = await removedResponse.json();
    assert.ok(removed.hiddenAt);
    assert.deepEqual(await (await remove()).json(), removed, 'removing twice is safe');
    assert.deepEqual(jobIds(await (await fetch(base + '/api/jobs')).json()), ['reused'], 'only the archived run leaves normal history');
    assert.deepEqual(jobIds(await (await fetch(base + '/api/jobs?includeHidden=1')).json()), ['reused', 'agent-test']);
    assert.equal(JSON.parse(readFileSync(jobs, 'utf8'))[0].hiddenAt, removed.hiddenAt);
    assert.equal((await fetch(base + '/api/jobs/missing/remove', { method: 'POST' })).status, 404);
    assert.equal(
      (
        await fetch(base + '/api/jobs/agent-test/remove', {
          method: 'POST',
          headers: { origin: 'https://example.test' },
        })
      ).status,
      403,
    );
    assert.deepEqual(jobIds((await call('list_jobs', {})).jobs), ['reused', 'agent-test'], 'MCP still discovers historical evidence');
    const job = await call('get_job', { jobId: 'agent-test' });
    assert.equal(job.outcome, 'fail');
    assert.equal(job.log, undefined);
    assert.match(job.viewerUrl, /\?job=agent-test$/);
    const wait = await call('wait_jobs', { jobIds: ['agent-test'], revisions: { 'agent-test': job.revision }, waitMs: 2000 });
    assert.deepEqual(wait.jobs, []);
    assert.deepEqual(wait.pendingJobIds, []);
    assert.equal(wait.timedOut, false);
    const network = await call('get_network', { jobId: 'agent-test' });
    assert.equal(network.requests.length, 5);
    assert.equal(network.nextCursor, 5);
    assert.equal(network.requests[0].errorBody, undefined);
    const second = await call('get_network', { jobId: 'agent-test', cursor: 5 });
    assert.equal(second.requests.length, 1);
    assert.equal(second.nextCursor, null);
    const success = await call('get_network', { jobId: 'agent-test', requestId: 'row-0', detail: true });
    assert.equal(success.requests.length, 1);
    assert.equal(success.requests[0].status, 200);
    assert.equal(success.requests[0].errorBody.message, 'Detailed diagnostic response');
    const page = await call('get_evidence', { jobId: 'agent-test', artifact: 'report', limit: 30 });
    assert.equal(page.text.length, 30);
    assert.equal(page.nextOffset, 30);
    const evidence = await call('get_evidence', { jobId: 'agent-test' });
    const artifact = await fetch(evidence.artifacts.find((a: any) => a.id === 'spec').url);
    assert.equal(await artifact.text(), 'spec contents');
    assert.equal((await fetch(base + '/api/jobs/agent-test/artifacts/secret')).status, 404);
    const reusedSummary = await call('get_job', { jobId: 'reused' });
    assert.equal(reusedSummary.specSelection.mode, 'reuse');
    assert.equal(reusedSummary.outcome, 'fail');
    assert.equal(reusedSummary.historicalExploration.verdict, 'pass');
    const current = await call('get_evidence', { jobId: 'reused' });
    assert.equal(current.failedSteps[0].evidence, 'Fresh regression');
    assert.equal(current.artifacts.find((a: any) => a.id === 'historical-report').historical, true);
    for (const id of ['report', 'historical-report', 'manifest', 'summary', 'results']) {
      const page = await call('get_evidence', { jobId: 'reused', artifact: id });
      const downloaded = await fetch(current.artifacts.find((a: any) => a.id === id).url);
      assert.equal(downloaded.status, 200);
      assert.equal(await downloaded.text(), page.text);
      if (id === 'historical-report') assert.equal(page.historical, true);
    }
    const frame = await client.callTool({ name: 'get_browser_frame', arguments: { jobId: 'agent-test' } });
    assert.ok((frame.content as any[]).some((c) => c.type === 'image'));
    const unchanged = await client.callTool({ name: 'get_browser_frame', arguments: { jobId: 'agent-test', knownFrameAt: 'frame-1' } });
    assert.equal((unchanged.structuredContent as any).data.unchanged, true);
    assert.equal((unchanged.content as any[]).length, 1);
    const cases = await call('list_cases', { query: '6003', limit: 1 });
    assert.equal(cases.cases[0].id, 6003);
    const fullCase = await call('get_case', { qaseCaseId: 6003 });
    assert.ok(fullCase.steps.length > 0);
    const workflow = await client.readResource({ uri: 'checker://workflow' });
    assert.match(JSON.stringify(workflow.contents), /done means/);
    app.kill('SIGTERM');
    await closed;
    app = spawn(process.execPath, ['src/app/server.ts'], { env, stdio: 'ignore' });
    closed = new Promise<void>((r) => app.once('exit', () => r()));
    await waitForApp();
    assert.deepEqual(jobIds(await (await fetch(base + '/api/jobs')).json()), ['reused'], 'removal survives server restart');
    assert.equal((await (await fetch(base + '/api/jobs/agent-test')).json()).hiddenAt, removed.hiddenAt);
    assert.equal(await (await fetch(base + '/api/jobs/agent-test/artifacts/spec')).text(), 'spec contents');
    assert.equal((await call('get_job', { jobId: 'agent-test' })).canReplay, true);
    assert.deepEqual((await call('wait_jobs', { jobIds: ['agent-test'] })).pendingJobIds, []);
    assert.equal((await (await fetch(base + '/api/settings')).json()).revision, savedSettings.revision);
    assert.equal((await (await fetch(base + '/api/jobs?archived=1')).json()).length, 1);
    const restore = await fetch(base + '/api/jobs/agent-test/restore', { method: 'POST', body: '{}' });
    assert.equal(restore.status, 200);
    assert.equal((await (await fetch(base + '/api/jobs')).json()).length, 2);
    const pin = await fetch(base + '/api/jobs/agent-test/organize', { method: 'POST', body: JSON.stringify({ pinned: true }) });
    assert.ok((await pin.json()).pinnedAt);
    const settle = await fetch(base + '/api/jobs/agent-test/organize', { method: 'POST', body: JSON.stringify({ settled: true }) });
    const settled = await settle.json();
    assert.ok(settled.settledAt);
    assert.equal(settled.pinnedAt, undefined);
    const deleted = await fetch(base + '/api/jobs/agent-test/delete', { method: 'POST', body: '{}' });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(base + '/api/jobs/agent-test')).status, 404);
    assert.equal((await fetch(base + '/api/jobs/agent-test/restore', { method: 'POST' })).status, 404);
    assert.deepEqual(jobIds((await call('list_jobs', {})).jobs), ['reused']);
    assert.equal(readFileSync(join(dir, 'codify/DEMO-6003.spec.ts'), 'utf8'), 'spec contents', 'deletion does not delete artifact files');
    const currentCase = await call('get_case', { project: 'LOCAL', caseId: full.id });
    const removeCase = await fetch(base + `/api/cases/LOCAL/${full.id}/remove`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: currentCase.revision }),
    });
    assert.equal(removeCase.status, 200);
    assert.equal((await fetch(base + `/api/cases/LOCAL/${full.id}`)).status, 404);
    app.kill('SIGTERM');
    await closed;
    app = spawn(process.execPath, ['src/app/server.ts'], { env, stdio: 'ignore' });
    closed = new Promise<void>((r) => app.once('exit', () => r()));
    await waitForApp();
    assert.equal((await fetch(base + '/api/jobs/agent-test')).status, 404, 'deleted run stays deleted across restart');
    assert.deepEqual(await (await fetch(base + '/api/jobs?archived=1')).json(), []);
    assert.equal((await fetch(base + `/api/cases/LOCAL/${full.id}`)).status, 404, 'deleted case stays deleted across restart');
  } finally {
    await client.close();
    app.kill('SIGTERM');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('promoted evidence exposes its source and paged original artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-promoted-api-'));
  try {
    populate(dir);
    const job = fixture(dir);
    const manifestPath = join(dir, 'codify/attempt.manifest.json');
    const results = join(dir, 'codify/results.json');
    atomicJson(manifestPath, { version: 1, state: 'completed' });
    atomicJson(results, { suites: [] });
    job.replay = {
      ...job.replay,
      results,
      avoidedExecutionMs: 1234,
      provenance: { kind: 'stabilization', independentRun: false, attemptId: 'attempt.fixture', manifestPath },
    };
    const compact = jobSummary(job, 'http://localhost:4100');
    assert.equal(compact.replay?.provenance.independentRun, false);
    assert.equal(compact.replay?.avoidedExecutionMs, 1234);
    const evidence = readEvidence(job, 'http://localhost:4100');
    assert.equal(evidence.provenance.kind, 'stabilization');
    assert.ok(evidence.artifacts?.some((a) => a.id === 'attempt'));
    assert.ok(evidence.artifacts?.some((a) => a.id === 'results'));
    assert.match(readEvidence(job, '', { artifact: 'attempt' }).text!, /completed/);
    assert.match(readEvidence(job, '', { artifact: 'results' }).text!, /suites/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup retention deletes managed run files and preserves case/result summaries across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-retention-api-'));
  const root = new URL('..', import.meta.url).pathname;
  mkdirSync(join(root, 'runs'), { recursive: true });
  const runDir = mkdtempSync(join(root, 'runs/retention-test-'));
  const generated = join(root, 'e2e/generated', basename(runDir));
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, 'LOCAL-1.spec.ts'), 'generated spec');
  populate(runDir);
  const catalog = new CaseCatalog(join(dir, 'cases.json'), join(dir, 'legacy'));
  const testCase = catalog.create({ title: 'Retained definition' });
  const before = readFileSync(catalog.path, 'utf8');
  const job = { ...fixture(runDir), caseSnapshot: testCase, createdAt: '2000-01-01T00:00:00Z', finishedAt: '2000-01-01T01:00:00Z' };
  const jobsPath = join(dir, 'jobs.json');
  writeFileSync(jobsPath, JSON.stringify([job]));
  const settings = new SettingsStore(join(dir, 'settings.json'));
  settings.save({ expectedRevision: 'initial', settings: { runCacheAfterDays: 8 } });
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const env = {
    ...process.env,
    E2E_APP_PORT: String(port),
    E2E_APP_OPEN: '0',
    E2E_JOBS_PATH: jobsPath,
    E2E_CASES_PATH: catalog.path,
    E2E_SETTINGS_PATH: settings.path,
    E2E_ENVIRONMENTS_PATH: join(dir, 'environments.json'),
  };
  let app = spawn(process.execPath, ['src/app/server.ts'], { env, stdio: 'ignore' });
  let closed = new Promise<void>((r) => app.once('exit', () => r()));
  const base = `http://127.0.0.1:${port}`;
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(base + '/api/config').then(
          (r) => r.ok,
          () => false,
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail('retention server did not start');
  };
  try {
    await ready();
    assert.equal(existsSync(runDir), false);
    assert.equal(existsSync(generated), false);
    const report = await (await fetch(base + '/api/storage/cleanup')).json();
    assert.equal(report.removed[0].id, job.id);
    const summary = await (await fetch(base + `/api/jobs/${job.id}?view=summary`)).json();
    assert.equal(summary.outcome, 'fail');
    assert.equal(summary.cacheClearedAt, report.at);
    assert.equal(summary.canReplay, false);
    const evidence = await (await fetch(base + `/api/jobs/${job.id}/evidence`)).json();
    assert.deepEqual(evidence.artifacts, []);
    assert.equal(evidence.failedStepCount, 1);
    assert.equal(evidence.cacheClearedAt, report.at);
    assert.equal(readFileSync(catalog.path, 'utf8'), before);
    const saved = JSON.parse(readFileSync(jobsPath, 'utf8'))[0];
    assert.deepEqual(saved.caseSnapshot, testCase);
    assert.deepEqual(saved.steps, job.steps);
    app.kill('SIGTERM');
    await closed;
    app = spawn(process.execPath, ['src/app/server.ts'], { env, stdio: 'ignore' });
    closed = new Promise<void>((r) => app.once('exit', () => r()));
    await ready();
    assert.equal((await (await fetch(base + `/api/jobs/${job.id}?view=summary`)).json()).cacheClearedAt, report.at);
    const again = await (await fetch(base + '/api/storage/cleanup', { method: 'POST', body: '{}' })).json();
    assert.deepEqual(again.removed, []);
  } finally {
    app.kill('SIGTERM');
    await closed;
    for (const path of [dir, runDir, generated]) rmSync(path, { recursive: true, force: true });
  }
});
