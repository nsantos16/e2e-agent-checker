import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../src/claude.ts';
import { createRunPricing } from '../src/pricing.ts';
import { command } from '../src/process.ts';
import { stageTools } from '../src/stage-tools.ts';
import type { RunMetrics } from '../src/usage.ts';

test('Claude usage survives cancellation; duplicate message snapshots do not double count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-test-')),
    old = process.env.PATH;
  writeFileSync(
    join(dir, 'claude'),
    `#!/usr/bin/env node\nconst e={type:'assistant',message:{id:'m1',model:'test',usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:4},content:[]}};console.log(JSON.stringify(e));console.log(JSON.stringify(e));setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  process.env.PATH = dir + ':' + old;
  const abort = new AbortController();
  let metrics: RunMetrics | undefined;
  try {
    await assert.rejects(
      runClaude({
        pricing: await createRunPricing(dir, {
          catalog: { test: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, cache_read_input_token_cost: 0.0000001 } },
          source: 'cache',
        }),
        prompt: 'test',
        cwd: dir,
        model: 'test',
        tools: [],
        allowedTools: [],
        transcriptPath: join(dir, 'events.jsonl'),
        signal: abort.signal,
        onMetrics: (m) => {
          metrics = m;
          if (m.usage.totalTokens === 19) setTimeout(() => abort.abort(new Error('cancelled')), 20);
        },
      }),
      /cancelled/,
    );
    assert.equal(metrics!.usage.totalTokens, 19);
    assert.equal(metrics!.usage.status, 'partial');
    assert.ok(Math.abs(metrics!.usage.estimatedApiCostUsd! - 0.0000204) < 1e-12);
    assert.ok(metrics!.usage.pricingSnapshotId);
    assert.ok(readFileSync(join(dir, 'events.jsonl'), 'utf8').includes('m1'));
  } finally {
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('process timeout rejects and missing executable rejects', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }), /time limit/);
  await assert.rejects(command('e2e-command-that-does-not-exist', []), /ENOENT/);
});
test('stage tools restrict reads/writes and cannot follow a spec symlink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-tools-'));
  const input = join(dir, 'input.json'),
    secret = join(dir, 'secret'),
    spec = join(dir, 'case.spec.ts');
  writeFileSync(input, 'allowed');
  writeFileSync(secret, 'private');
  mkdirSync(join(dir, 'codify'));
  const service = await stageTools({ readFiles: [input], specPath: spec, runDir: dir, maxAttempts: 1 });
  try {
    assert.equal((await service.call('read_input', { path: input })).content[0].text, 'allowed');
    assert.equal((await service.call('read_input', { path: secret })).isError, true);
    assert.equal((await service.call('write_spec', { source: 'test source' })).isError, false);
    assert.equal(readFileSync(spec, 'utf8'), 'test source');
    rmSync(spec);
    symlinkSync(secret, spec);
    assert.equal((await service.call('write_spec', { source: 'replace' })).isError, true);
    assert.equal(readFileSync(secret, 'utf8'), 'private');
    assert.equal((await service.call('shell', { command: 'pwd' })).isError, true);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stabilization preserves a failing exit after Playwright clears output, and enforces attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-attempts-')),
    old = process.env.PATH;
  const spec = join(dir, 'test.spec.ts');
  writeFileSync(spec, 'test');
  mkdirSync(join(dir, 'codify'));
  writeFileSync(
    join(dir, 'replay.env'),
    `E2E_SPEC_DIR='${dir}'\nE2E_SPEC_FILE='test.spec.ts'\nE2E_BASE_URL='http://localhost'\nE2E_STORAGE_STATE='${dir}/state.json'\n`,
  );
  writeFileSync(
    join(dir, 'npx'),
    `#!/usr/bin/env node\nconst fs=require('node:fs');const out=process.env.E2E_OUTPUT_DIR;fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/results.json',JSON.stringify({"suites": [{"specs": [{"tests": [{"results": [{"status": "failed", "steps": [{"title": "Step 2: persisted newline", "error": {"message": "wrong value"}}]}]}]}]}]}));console.log('assertion failed');process.exitCode=1;`,
    { mode: 0o755 },
  );
  process.env.PATH = dir + ':' + old;
  const service = await stageTools({ specPath: spec, runDir: dir, maxAttempts: 1 });
  try {
    const result = await service.call('try_spec', {});
    assert.match(result.content[0].text, /exit 1/);
    assert.match(result.content[0].text, /assertion failed/);
    const recorded = JSON.parse(readFileSync(join(dir, 'codify/last-attempt.json'), 'utf8'));
    assert.equal(recorded.result.status, 'failed');
    assert.equal(recorded.result.failedStep, 'Step 2: persisted newline');
    const denied = await service.call('try_spec', {});
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /BUDGET_EXCEEDED/);
  } finally {
    process.env.PATH = old;
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
