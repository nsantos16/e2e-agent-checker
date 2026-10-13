import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunPricing, priceClaudeResult } from '../src/pricing.ts';
import { claudeUsage, codexUsage, emptyUsage, mergeUsage } from '../src/usage.ts';

const catalog = {
  model: {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.2e-6,
    cache_creation_input_token_cost: 2.5e-6,
  },
  other: {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 20e-6,
    cache_read_input_token_cost: 0.4e-6,
    cache_creation_input_token_cost: 5e-6,
  },
};
const close = (actual: number | null, expected: number) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('tokentally prices provider counts once, pins model rates, and preserves unknown totals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-pricing-'));
  try {
    const pricing = await createRunPricing(dir, { catalog, source: 'cache' });
    const raw = codexUsage({
      inputTokens: 1000,
      cachedInputTokens: 800,
      cacheWriteInputTokens: 50,
      outputTokens: 100,
      reasoningOutputTokens: 60,
      totalTokens: 1100,
    });
    const first = pricing.price(raw, 'model');
    close(first.estimatedApiCostUsd, 150 * 2e-6 + 800 * 0.2e-6 + 50 * 2.5e-6 + 100 * 10e-6);
    assert.equal(first.totalTokens, 1100);
    assert.equal(first.reasoningTokens, 60);
    assert.equal(first.billedCostUsd, null);
    assert.deepEqual(pricing.price(raw, 'model'), first, 'repeated cumulative updates replace the estimate');
    const claude = pricing.price(
      claudeUsage({ input_tokens: 150, cache_read_input_tokens: 800, cache_creation_input_tokens: 50, output_tokens: 100 }, 0.9, true),
      'model',
    );
    close(claude.estimatedApiCostUsd, first.estimatedApiCostUsd!);
    assert.equal(claude.providerReportedCostUsd, 0.9, 'reported cost remains separate');
    assert.equal(mergeUsage([first, claude]).pricingSnapshotId, first.pricingSnapshotId);
    close(mergeUsage([first, claude]).estimatedApiCostUsd, first.estimatedApiCostUsd! * 2);
    assert.equal(pricing.price(raw, 'unlisted-model').estimatedApiCostUsd, null);
    assert.equal(pricing.price(emptyUsage(), 'model').estimatedApiCostUsd, null);
    assert.equal(pricing.price({ ...raw, cacheReadTokens: null }, 'model').estimatedApiCostUsd, null);
    assert.equal(pricing.price({ ...raw, cacheReadTokens: 2000 }, 'model').estimatedApiCostUsd, null);
    assert.equal(mergeUsage([first, pricing.price(raw, 'unlisted-model')]).estimatedApiCostUsd, null);
    const snapshot = JSON.parse(readFileSync(join(dir, 'pricing.json'), 'utf8'));
    assert.equal(snapshot.id, first.pricingSnapshotId);
    assert.equal(snapshot.basis, 'standard-api');
    assert.equal(snapshot.catalogSource, 'cache');
    assert.equal(snapshot.catalogHash.length, 64);
    assert.ok(Number.isFinite(Date.parse(snapshot.capturedAt)));
    assert.deepEqual(snapshot.models.model, {
      inputUsdPerToken: 2e-6,
      outputUsdPerToken: 10e-6,
      cachedInputUsdPerToken: 0.2e-6,
      cacheCreationInputUsdPerToken: 2.5e-6,
    });
    assert.equal(snapshot.models['unlisted-model'], null);
    const secondDir = mkdtempSync(join(dir, 'second-'));
    const second = await createRunPricing(secondDir, {
      catalog: { model: { input_cost_per_token: 1, output_cost_per_token: 1 } },
      source: 'network',
    });
    assert.notEqual(second.price(raw, 'model').pricingSnapshotId, first.pricingSnapshotId);
    assert.deepEqual(pricing.price(raw, 'model'), first, 'existing run rates do not follow a refreshed catalog');
    assert.equal(JSON.parse(readFileSync(join(dir, 'pricing.json'), 'utf8')).id, first.pricingSnapshotId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude mixed-model pricing reconciles final counts and rejects incomplete attribution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-pricing-'));
  try {
    const pricing = await createRunPricing(dir, { catalog, source: 'network' });
    const part = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheCreationInputTokens: 20 };
    const usage = claudeUsage(
      { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 },
      0.3,
      true,
    );
    const priced = priceClaudeResult(usage, { model: part, other: part }, [], pricing);
    close(priced.estimatedApiCostUsd, 3 * (100 * 2e-6 + 10 * 10e-6 + 50 * 0.2e-6 + 20 * 2.5e-6));
    assert.equal(priced.providerReportedCostUsd, 0.3);
    assert.equal(priced.status, 'complete');
    assert.equal(priceClaudeResult(usage, { model: part }, ['model'], pricing).estimatedApiCostUsd, null);
    assert.equal(priceClaudeResult(usage, { model: part, unknown: part }, [], pricing).estimatedApiCostUsd, null);
    assert.equal(priceClaudeResult(usage, undefined, ['model', 'other'], pricing).estimatedApiCostUsd, null);
    assert.ok(priceClaudeResult(usage, undefined, ['model'], pricing).estimatedApiCostUsd !== null);
    const unavailable = await createRunPricing(dir, { catalog: null, source: 'none' });
    const missing = unavailable.price(usage, 'model');
    assert.equal(missing.estimatedApiCostUsd, null);
    assert.equal(missing.totalTokens, usage.totalTokens);
    assert.equal(missing.providerReportedCostUsd, 0.3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
