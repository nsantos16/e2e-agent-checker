import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { saveInstance, getInstance, readInstances, selectInstance, deleteInstance, loginCommand } from '../src/providers/instances.ts';
import { listProviders, preflight } from '../src/providers/index.ts';
import { runNativeText } from '../src/runner.ts';
import { createRunPricing } from '../src/pricing.ts';
import type { ProviderKind, Target } from '../src/providers/schema.ts';

// Real subprocesses with fake native profiles: protocol, environment, lifecycle, no paid calls.
for (const kind of ['claude-code', 'codex'] as ProviderKind[])
  test(`${kind}: separate profiles, catalogs, identity, redaction, limits, cancellation and isolation`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'checker-provider-'));
    const savedEnv = { ...process.env };
    const binary = join(root, 'native');
    copyFileSync(resolve('tests/fixtures/native-provider.mjs'), binary);
    chmodSync(binary, 0o755);
    process.env.E2E_PROVIDERS_PATH = join(root, 'instances.json');
    process.env.E2E_FAKE_KIND = kind;
    process.env.ANTHROPIC_API_KEY = 'ambient-secret-never-forward';
    process.env.OPENAI_API_KEY = 'ambient-openai-never-forward';
    const profile = (id: string, overrides = {}) => {
      const path = join(root, id);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'profile.json'), JSON.stringify({ email: `${id}@fixture.test`, models: [id], ...overrides }));
      return path;
    };
    const events = (id: string) =>
      readFileSync(join(root, id, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
    const create = (id: string) => saveInstance({ instance: { id, provider: kind, name: id, binaryPath: binary, configDir: profile(id) } });
    const target = (id: string): Target => ({
      provider: kind,
      instanceId: id,
      model: id,
      authMode: 'subscription',
      options: { effort: 'low' },
    });
    try {
      const a = create('personal'),
        b = create('work');
      const [pa, pb] = await Promise.all([listProviders(true, a.id), listProviders(true, b.id)]);
      assert.equal(pa[0].ready, true);
      assert.equal(pb[0].ready, true);
      assert.equal(pa[0].account?.email, 'personal@fixture.test');
      assert.deepEqual(
        pb[0].models.map((m) => m.id),
        ['work'],
      );
      assert.notEqual(pa[0].accountFingerprint, pb[0].accountFingerprint);
      assert.ok(pa[0].ignoredEnvironment?.includes('ANTHROPIC_API_KEY'));
      assert.doesNotMatch(JSON.stringify(pa), /ambient-secret-never-forward|must-not-escape/);
      assert.ok(events('personal').every((e) => !e.apiKeyPresent && e.home === savedEnv.HOME));
      assert.ok(events('work').every((e) => e.profile === join(root, 'work')));
      assert.equal(
        events('personal').some((e) => e.action === 'run' || e.action === 'turn/start'),
        false,
        'health never runs a prompt',
      );
      selectInstance(b.id, b.revision);
      assert.equal(readInstances().selectedInstanceId, 'work');
      assert.equal(getInstance(`${kind}-default`).id, `${kind}-default`, 'selection never rebinds legacy defaults');
      assert.match(loginCommand(a), new RegExp(kind === 'codex' ? 'CODEX_HOME=' : 'CLAUDE_CONFIG_DIR='));
      assert.doesNotMatch(loginCommand(a), /ambient-secret-never-forward|(?:^| )HOME=/); // CODEX_HOME checked separately below
      const selected = await preflight(target('personal'));
      assert.equal(selected.target.instanceRevision, a.revision);
      await assert.rejects(preflight({ ...target('personal'), model: 'work' }), { code: 'MODEL_UNAVAILABLE' });
      await assert.rejects(preflight({ ...target('personal'), options: { effort: 'impossible' } }), { code: 'OPTION_UNAVAILABLE' });
      const run = async (id: string, signal?: AbortSignal, onMetrics?: any) => {
        const dir = join(root, `run-${id}`);
        mkdirSync(dir, { recursive: true });
        return runNativeText({
          prompt: 'fixture',
          cwd: root,
          model: id,
          target: target(id),
          transcriptPath: join(dir, 'transcript.jsonl'),
          pricing: await createRunPricing(dir, { catalog: {}, source: 'cache' }),
          signal,
          onMetrics,
        });
      };
      const [ra, rb] = await Promise.all([run('personal'), run('work')]);
      assert.equal(ra.resultText, 'personal@fixture.test');
      assert.equal(rb.resultText, 'work@fixture.test');
      assert.equal(ra.metrics.target?.instanceId, 'personal');
      assert.equal(rb.metrics.target?.instanceId, 'work');
      if (kind === 'codex') {
        const thread = events('personal').find((e) => e.action === 'thread/start');
        assert.equal(thread.params.allowProviderModelFallback, false);
        assert.equal(thread.params.config.mcp_servers.untrusted.enabled, false);
        assert.equal(thread.params.config.features.shell_tool, false);
        assert.deepEqual(thread.params.dynamicTools, []);
        assert.equal(events('personal').find((e) => e.action === 'reply')?.error?.message, 'Tool not permitted');
        profile('personal', { substitute: 'work' });
        await assert.rejects(run('personal'), { code: 'MODEL_CHANGED' });
      } else {
        const call = events('personal').find((e) => e.action === 'run');
        assert.ok(call.args.includes('--restricted') && call.args.includes('--strict-mcp-config'));
        assert.ok(call.args.includes('--disable-slash-commands'));
        assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
        assert.equal(JSON.parse(call.args[call.args.indexOf('--settings') + 1]).disableAllHooks, true);
      }
      profile('personal', { hang: true });
      const abort = new AbortController();
      let final: any;
      await assert.rejects(
        run('personal', abort.signal, (m: any) => {
          final = m;
          if (m.usage.inputTokens != null) setTimeout(() => abort.abort(new Error('cancel fixture')), 20);
        }),
        /cancel fixture/,
      );
      assert.equal(final.usage.inputTokens, 10);
      assert.equal(final.target.instanceId, 'personal');
      const pid = events('personal')
        .filter((e) => e.action === (kind === 'codex' ? 'turn/start' : 'run'))
        .at(-1).pid;
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
      profile('personal', { email: 'changed@fixture.test' });
      await assert.rejects(preflight(selected.target), { code: 'ACCOUNT_CHANGED' });
      profile('personal', { models: [] });
      assert.deepEqual((await listProviders(true, 'personal'))[0].models, [], 'authoritative empty catalog clears cache');
      profile('personal', { auth: 'api-key' });
      await assert.rejects(preflight(target('personal')), { code: 'AUTH_MODE_MISMATCH' });
      profile('personal', { auth: 'logged-out' });
      assert.equal((await listProviders(true, 'personal'))[0].auth, 'logged-out');
      profile('personal', { error: '401 expired refresh_token=do-not-display-secret' });
      const failed = (await listProviders(true, 'personal'))[0];
      assert.equal(failed.installed, true);
      assert.equal(failed.ready, false);
      assert.match(failed.reason!, /^AUTH_EXPIRED:/);
      assert.doesNotMatch(JSON.stringify(failed), /do-not-display-secret/);
      profile('personal', { exhausted: true });
      await assert.rejects(kind === 'codex' ? preflight(target('personal')) : run('personal'), {
        code: 'USAGE_EXHAUSTED',
        retryAt: 4102444800,
      });
      const { revision: _revision, ...config } = a;
      const changed = saveInstance({ instance: { ...config, enabled: false }, expectedRevision: a.revision });
      await assert.rejects(preflight(selected.target), { code: 'INSTANCE_CHANGED' });
      assert.equal((await listProviders(false, 'personal'))[0].ready, false, 'revision invalidates cached readiness');
      assert.throws(() => selectInstance('personal', changed.revision), { code: 'INSTANCE_DISABLED' });
      assert.throws(() => deleteInstance('work', 'stale'), { code: 'REVISION_CONFLICT' });
      symlinkSync(join(root, 'work'), join(root, 'alias'));
      assert.throws(
        () =>
          saveInstance({ instance: { id: 'alias', provider: kind, name: 'Alias', binaryPath: binary, configDir: join(root, 'alias') } }),
        { code: 'PROFILE_CONFLICT' },
      );
      const { revision: workRevision, ...workConfig } = b;
      saveInstance({ instance: { ...workConfig, binaryPath: join(root, 'missing-binary') }, expectedRevision: workRevision });
      const missing = (await listProviders(true, 'work'))[0];
      assert.equal(missing.installed, false);
      assert.match(missing.reason!, /^INSTALLATION_MISSING:/);
      deleteInstance('work', getInstance('work').revision);
      assert.throws(() => getInstance('work'), { code: 'INSTANCE_NOT_FOUND' });
      assert.equal(
        JSON.parse(readFileSync(process.env.E2E_PROVIDERS_PATH, 'utf8')).instances.find((i: any) => i.id === 'personal').enabled,
        false,
      );
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
      rmSync(root, { recursive: true, force: true });
    }
  });

test('provider diagnostics redact credential fields and text without destroying usage counters', async () => {
  const { redactProviderEvent } = await import('../src/providers/telemetry.ts');
  const value = JSON.parse(
    redactProviderEvent({
      accessToken: 'never',
      nested: { refresh_token: 'never', inputTokens: 42 },
      text: 'Bearer abc.def password=never',
      usage: { totalTokens: 50 },
    }),
  );
  assert.equal(value.accessToken, '[redacted]');
  assert.equal(value.nested.refresh_token, '[redacted]');
  assert.equal(value.nested.inputTokens, 42);
  assert.equal(value.usage.totalTokens, 50);
  assert.doesNotMatch(JSON.stringify(value), /never|abc\.def/);
});
