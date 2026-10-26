import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEffect, deadline, sdk } from '../src/runtime/effect.ts';
import { CheckerLive } from '../src/runtime/services.ts';
import { ProcessRunner, command, type CommandOptions } from '../src/process.ts';
import { CredentialStore, resolveTestUserEffect } from '../src/credentials.ts';
import { PricingCatalog } from '../src/pricing.ts';
import { ProviderRegistry } from '../src/providers/index.ts';
import { codexConnectionEffect } from '../src/providers/rpc.ts';
import { verifyEffect } from '../src/verify.ts';
import { stageToolsEffect } from '../src/stage-tools.ts';
import { CaseCatalog } from '../src/cases.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
test('Effect interruption waits for process cleanup and preserves the public abort reason', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('test cancellation'), {
    code: 'CANCELLED',
  });
  let pid = 0;
  await assert.rejects(
    command(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"], {
      signal: controller.signal,
      onLine: (line) => {
        pid = Number(line);
        controller.abort(reason);
      },
    }),
    (error) => error === reason,
  );
  assert.ok(pid > 0);
  // SIGKILL is sent before the scope returns; let the OS reap the process.
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(alive(pid), false);
});

test('Effect deadlines release acquired resources before reporting a typed timeout', async () => {
  const events: string[] = [];
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => events.push('acquired')),
        () =>
          Effect.sync(() => {
            events.push('released');
          }),
      );
      yield* Effect.never;
    }),
  );
  await assert.rejects(runEffect(deadline(program, 20)), { code: 'TIMEOUT' });
  assert.deepEqual(events, ['acquired', 'released']);
});

test('credential services are injectable and parallel resolution cancels a failed sibling', async () => {
  let cancelled = false;
  const effect = resolveTestUserEffect({
    id: 'qa',
    name: 'QA',
    usernameRef: 'env://USER',
    passwordRef: 'env://PASSWORD',
  }).pipe(
    Effect.provideService(CredentialStore, {
      read: (ref) =>
        ref.endsWith('PASSWORD')
          ? Effect.andThen(Effect.sleep(10), Effect.fail(new Error('missing credential')))
          : sdk(
              (signal) =>
                new Promise<string>((_, reject) =>
                  signal.addEventListener(
                    'abort',
                    () => {
                      cancelled = true;
                      reject(new Error('aborted'));
                    },
                    { once: true },
                  ),
                ),
            ),
    }),
  );
  await assert.rejects(runEffect(effect), /missing credential/);
  assert.equal(cancelled, true);
});

test('failed Codex initialization closes the scoped RPC subprocess', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-rpc-scope-'));
  const old = process.env.PATH;
  const pidPath = join(dir, 'pid');
  writeFileSync(
    join(dir, 'codex'),
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,error:{message:'fixture initialization failed'}}));});`,
    { mode: 0o755 },
  );
  process.env.PATH = dir + ':' + old;
  try {
    await assert.rejects(runEffect(Effect.scoped(codexConnectionEffect())), /fixture initialization failed/);
    const pid = Number(readFileSync(pidPath, 'utf8'));
    assert.equal(alive(pid), false);
  } finally {
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verification composes injected provider, process and pricing services without real model calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-effect-verify-'));
  const state = join(dir, 'state.json');
  writeFileSync(state, '{}');
  mkdirSync(join(dir, 'fixtures'));
  const cases = new CaseCatalog(join(dir, 'cases.json'), join(dir, 'fixtures'));
  const testCase = cases.create({
    title: 'Effect fixture',
    status: 'active',
    steps: [{ action: 'Open fixture', expected_result: 'Ready' }],
  });
  let commands = 0;
  const stages: string[] = [];
  try {
    const summary = await runEffect(
      verifyEffect({
        project: testCase.project,
        caseId: testCase.id,
        caseSnapshot: testCase,
        slot: 'effect-fixture',
        role: 'qa',
        environment: {
          id: 'fixture',
          name: 'Fixture',
          revision: '1',
          kind: 'hosted',
          baseUrl: 'http://fixture.test',
          devMode: 'test',
          users: [{ id: 'qa', name: 'QA', usernameRef: 'env://FIXTURE_USER', passwordRef: 'env://FIXTURE_PASSWORD' }],
        },
        base: 'http://fixture.test',
        storageState: state,
        model: 'fixture-model',
        runDir: dir,
        target: {
          provider: 'claude-code',
          model: 'fixture-model',
          authMode: 'subscription',
        },
        onStage: (stage) => stages.push(stage),
      }).pipe(
        Effect.provideService(ProviderRegistry, {
          inspect: (id) =>
            Effect.succeed({
              id,
              name: 'Fixture',
              installed: true,
              auth: 'subscription',
              ready: true,
              loginCommand: 'unused',
              models: [{ id: 'fixture-model', name: 'Fixture' }],
            }),
        }),
        Effect.provideService(PricingCatalog, {
          load: Effect.succeed({
            catalog: {
              'fixture-model': {
                input_cost_per_token: 1e-6,
                output_cost_per_token: 2e-6,
              },
            },
            source: 'cache' as const,
          }),
        }),
        Effect.provideService(ProcessRunner, {
          execute: (name: string, _args: string[], opts: CommandOptions = {}) =>
            Effect.sync(() => {
              assert.equal(name, 'claude');
              commands++;
              const usage = {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              };
              opts.onLine?.(
                JSON.stringify({
                  type: 'assistant',
                  message: {
                    id: 'message-1',
                    model: 'fixture-model',
                    usage,
                    content: [],
                  },
                }),
              );
              opts.onLine?.(
                JSON.stringify({
                  type: 'result',
                  usage,
                  total_cost_usd: 0.5,
                  num_turns: 1,
                  result: JSON.stringify({
                    caseId: testCase.id,
                    verdict: 'blocked',
                    steps: [
                      {
                        position: 1,
                        verdict: 'blocked',
                        evidence: 'Fixture unavailable',
                      },
                    ],
                  }),
                }),
              );
              return { code: 0, stdout: '', stderr: '' };
            }),
        }),
        Effect.provide(CheckerLive),
      ),
    );
    assert.equal(summary.outcome, 'blocked');
    assert.deepEqual(stages, ['explore']);
    assert.equal(commands, 1);
    const metrics = JSON.parse(readFileSync(join(dir, 'explore/metrics.json'), 'utf8'));
    assert.equal(metrics.usage.totalTokens, 110);
    assert.ok(Math.abs(metrics.usage.estimatedApiCostUsd - 0.00012) < 1e-12);
    assert.equal(metrics.usage.pricingSnapshotId, JSON.parse(readFileSync(join(dir, 'pricing.json'), 'utf8')).id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling browser MCP initialization releases the partially connected subprocess', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-mcp-scope-'));
  const old = process.env.PATH;
  const pidPath = join(dir, 'pid');
  writeFileSync(
    join(dir, 'npx'),
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  process.env.PATH = dir + ':' + old;
  const controller = new AbortController();
  const reason = new Error('cancel initialization');
  const task = assert.rejects(
    runEffect(Effect.scoped(stageToolsEffect({ browserConfig: 'unused' })), controller.signal),
    (error) => error === reason,
  );
  try {
    for (let i = 0; i < 200 && !existsSync(pidPath); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(pidPath));
    const pid = Number(readFileSync(pidPath, 'utf8'));
    controller.abort(reason);
    await task;
    assert.equal(alive(pid), false);
  } finally {
    controller.abort(reason);
    await task;
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
