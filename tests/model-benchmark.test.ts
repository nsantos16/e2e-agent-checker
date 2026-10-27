import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeModelBenchmark, type BenchmarkRow } from './model-benchmark-analysis.ts';
import { withoutBrowserBatch, withoutBatchGuidance } from './model-benchmark-variants.ts';
test('live benchmark pairs workflows and does not score a fast failure as a speed improvement', () => {
  const row = (variant: 'baseline' | 'candidate', repetition: number, elapsedMs: number, correct = true): BenchmarkRow => ({
    id: `${variant}-${repetition}`,
    variant,
    repetition,
    workflow: 'fixture',
    elapsedMs,
    correct,
    errors: [],
    stages: {},
  });
  const faster = summarizeModelBenchmark(Array.from({ length: 5 }, (_, i) => [row('baseline', i, 100), row('candidate', i, 70)]).flat());
  assert(Math.abs(faster.pairedMedianSpeedup! - 0.3) < 1e-10);
  assert.equal(faster.meetsTarget, true);
  const failed = summarizeModelBenchmark([row('baseline', 0, 100), row('candidate', 0, 1, false)]);
  assert(failed.pairedMedianSpeedup! < 0);
  assert.equal(failed.meetsTarget, false);
  assert.equal(failed.groups[1].correct, 0);
  const incomplete = summarizeModelBenchmark([row('baseline', 0, 100), row('candidate', 1, 70)]);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.meetsTarget, false);
  const unfinished = summarizeModelBenchmark([row('baseline', 0, 100), row('candidate', 0, 70)], 600_000, 2);
  assert.equal(unfinished.complete, false);
  assert.equal(unfinished.meetsTarget, false);
});

test('batch ablation removes only generic batching while preserving calls, cancellation, checks and evidence guidance', async () => {
  const calls: unknown[] = [];
  const service = {
    tools: ['browser_batch', 'browser_run_code_unsafe', 'read_inputs', 'qa_tool_result'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
    })),
    call: async (...args: any[]) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
    close: async () => {
      calls.push('closed');
    },
  };
  const control = withoutBrowserBatch(service);
  assert.deepEqual(control.tools, service.tools.slice(1));
  assert.equal((await control.call('browser_batch', {})).isError, true);
  assert.equal(calls.length, 0);
  const signal = new AbortController().signal;
  await control.call('browser_run_code_unsafe', { code: 'assertions retained' }, signal);
  assert.deepEqual(calls, [['browser_run_code_unsafe', { code: 'assertions retained' }, signal]]);
  await control.close();
  assert.equal(calls.at(-1), 'closed');
  const original = [
    '6. Use observed locators and throw immediately on a mismatch.',
    '   Use `browser_batch` for known sequences using different tools.',
    '   The batch stops after errors; never automatically retry it or resubmit the batch.',
    '   Retrieve details with qa_tool_result; preserve the complete ordered action log.',
    '7. Network diagnostics and remaining rules stay identical.',
  ].join('\n');
  const revised = withoutBatchGuidance(original);
  assert(!revised.includes('browser_batch'));
  assert(revised.includes('throw immediately on a mismatch'));
  assert(revised.includes('never automatically retry'));
  assert(revised.includes('complete ordered action log'));
  assert(revised.includes('qa_tool_result'));
  assert.equal(revised.slice(revised.indexOf('7. Network')), original.slice(original.indexOf('7. Network')));
});
