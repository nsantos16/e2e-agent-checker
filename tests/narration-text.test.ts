import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planNarration } from '../src/narration-text.ts';
import { defaultVoiceOptions } from '../src/demo-contract.ts';
import { getInstance, saveInstance } from '../src/providers/instances.ts';

for (const provider of ['codex', 'claude-code'] as const)
  test(`narration uses the configured ${provider} native profile and snapshots its identity`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'checker-provider-narration-'));
    const previous = { ...process.env };
    try {
      process.env.E2E_PROVIDERS_PATH = join(root, 'providers.json');
      process.env.E2E_FAKE_KIND = provider;
      process.env.OPENAI_API_KEY = 'must-not-reach-text-worker';
      const binary = join(root, 'native');
      copyFileSync(resolve('tests/fixtures/native-provider.mjs'), binary);
      chmodSync(binary, 0o755);
      const profile = join(root, 'profile');
      mkdirSync(profile);
      const model = provider === 'codex' ? 'gpt-6-luna' : 'haiku';
      writeFileSync(
        join(profile, 'profile.json'),
        JSON.stringify({
          email: JSON.stringify({ choices: [{ position: 1, variant: 0 }] }),
          models: [model],
        }),
      );
      const { revision, ...current } = getInstance(`${provider}-default`);
      const instance = saveInstance({
        expectedRevision: revision,
        instance: {
          ...current,
          binaryPath: binary,
          configDir: profile,
          options: { effort: 'high' },
        },
      });
      const result = await planNarration(
        [{ position: 1, choices: ['Step one failed.'] }],
        { ...defaultVoiceOptions, textModel: model },
        root,
        AbortSignal.timeout(15000),
      );
      assert.deepEqual(result.choices, [{ position: 1, variant: 0 }]);
      assert.equal(result.target?.instanceId, instance.id);
      assert.equal(result.target?.instanceRevision, instance.revision);
      assert.match(result.target?.accountFingerprint ?? '', /^[a-f0-9]{64}$/);
      assert.equal(result.target?.authMode, 'subscription');
      assert.equal(result.target?.options?.effort, 'low');
      const events = readFileSync(join(profile, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      assert.ok(events.every((e) => e.profile === profile && !e.apiKeyPresent));
      if (provider === 'codex') {
        const call = events.find((e) => e.action === 'turn/start');
        assert.equal(call.params.effort, 'low');
      } else {
        const call = events.find((e) => e.action === 'run');
        assert.equal(call.args[call.args.indexOf('--effort') + 1], 'low');
        assert.equal(call.args[call.args.indexOf('--max-turns') + 1], '1');
      }
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
      Object.assign(process.env, previous);
      rmSync(root, { recursive: true, force: true });
    }
  });
