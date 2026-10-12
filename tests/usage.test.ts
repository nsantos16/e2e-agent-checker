import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeUsage, codexUsage, emptyUsage, mergeUsage } from '../src/usage.ts';
test('Claude cache tokens are included exactly once', () => {
  const u = claudeUsage({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }, 0.12, true);
  assert.equal(u.inputTokens, 60);
  assert.equal(u.totalTokens, 64);
  assert.equal(u.providerReportedCostUsd, 0.12);
  assert.equal(u.billedCostUsd, null);
});
test('Codex cached and reasoning tokens are subsets', () => {
  const u = codexUsage({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 120 });
  assert.equal(u.totalTokens, 120);
  assert.equal(u.inputTokens, 100);
  assert.equal(u.providerReportedCostUsd, null);
});
test('unknown usage stays unknown and stages add once', () => {
  const a = claudeUsage({ input_tokens: 10, output_tokens: 5 }, 0.1, true);
  const b = claudeUsage({ input_tokens: 20, output_tokens: 7 }, 0.2, true);
  assert.equal(mergeUsage([a, b]).totalTokens, 42);
  assert.equal(mergeUsage([a, b]).status, 'complete');
  assert.equal(mergeUsage([a, emptyUsage('cursor', 'unavailable')]).totalTokens, null);
  assert.equal(mergeUsage([a, emptyUsage('cursor', 'unavailable')]).status, 'partial');
  assert.equal(claudeUsage({}).totalTokens, null);
});
