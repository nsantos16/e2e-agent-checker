// Explicit live benchmark: uses the requested Codex subscription model. Never part of npm test.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { stageTools as candidateTools, type StageConfig } from '../src/stage-tools.ts';
import { runCodex, type ToolService } from '../src/providers/codex.ts';
import { Rpc, codexConnection } from '../src/providers/rpc.ts';
import { lastJsonObject } from '../src/claude.ts';
import { writeReplayEnv } from '../src/codify.ts';
import { replay } from '../src/replay.ts';
import { command } from '../src/process.ts';
import { type RunMetrics } from '../src/usage.ts';
import {
  benchmarkCase,
  mutations,
  startBenchmarkFixture,
  verifyExploration,
  workflows,
  type Workflow,
} from './fixtures/model-benchmark.ts';
import { random, summarizeModelBenchmark, type BenchmarkRow } from './model-benchmark-analysis.ts';
import { withoutBrowserBatch, withoutBatchGuidance } from './model-benchmark-variants.ts';

const root = new URL('..', import.meta.url).pathname;
const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    model: { type: 'string', default: 'gpt-6.1-sol' },
    repeats: { type: 'string', default: '5' },
    pilot: { type: 'boolean', default: false },
    resume: { type: 'string' },
    ablation: { type: 'boolean', default: false },
  },
});
const baselineRoot = resolve(values.baseline ?? (values.ablation ? root : resolve(root, '../e2e-agent-checker-batching-baseline'))),
  candidateRoot = values.ablation ? baselineRoot : root,
  model = values.model!,
  repeats = values.pilot ? 1 : Number(values.repeats);
assert(model === 'gpt-6.1-sol', 'This experiment is pinned to the requested GPT-6.1-Sol model');
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
const selected = workflows;
const baselineTools = (await import(pathToFileURL(join(baselineRoot, 'src/stage-tools.ts')).href)).stageTools as typeof candidateTools;
const runDir = values.resume
  ? resolve(values.resume)
  : mkdtempSync(join(root, values.ablation ? 'runs/sol61-batch-ablation-' : 'runs/sol61-model-benchmark-'));
const rows: BenchmarkRow[] = existsSync(join(runDir, 'results.json')) ? JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) : [];
const deadlineMs = 600_000,
  reasoning = 'medium',
  seed = 20261026;
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const state = join(runDir, 'state.json');
writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
const emit = (value: unknown) => {
  appendFileSync(join(runDir, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...(value as any) }) + '\n');
  console.log(JSON.stringify(value));
};
const fixture = await startBenchmarkFixture((observation) =>
  appendFileSync(join(runDir, 'observations.jsonl'), JSON.stringify(observation) + '\n'),
);

// Instrument the existing common provider adapter. Only these identical per-thread
// settings are overridden; neither tool choice nor output is altered by this observer.
let active: any;
const pending = new Map<any, string>();
const originalSend = Rpc.prototype.send,
  originalReceive = Rpc.prototype.receive;
Rpc.prototype.send = function (value: any) {
  if (active) {
    if (value.method === 'thread/start') {
      value.params.serviceTier = 'default';
      value.params.config.model_reasoning_effort = reasoning;
    }
    if (value.method === 'turn/start') {
      value.params.effort = reasoning;
      value.params.serviceTierForTurn = 'default';
      active.turnStart = performance.now();
    }
    if (value.method && value.id !== undefined) pending.set(value.id, value.method);
    if (!value.method && value.result?.contentItems) active.providerResultBytes += Buffer.byteLength(JSON.stringify(value.result));
  }
  return originalSend.call(this, value);
};
Rpc.prototype.receive = function (value: any) {
  if (active) {
    const method = value.method ?? pending.get(value.id);
    if (method === 'thread/start' && value.result)
      active.resolved = {
        model: value.result.model,
        reasoningEffort: value.result.reasoningEffort,
        serviceTier: value.result.serviceTier,
      };
    if (value.method === 'turn/completed') active.turnEnd = performance.now();
    if (value.method === 'item/completed' && value.params?.item?.type === 'contextCompaction') active.compactions++;
    if (value.method === 'thread/tokenUsage/updated') active.usageUpdates++;
    if (value.method === 'item/tool/call')
      appendFileSync(active.rpcPath, JSON.stringify({ at: Date.now(), method, tool: value.params?.tool }) + '\n');
    if (value.method === 'error') appendFileSync(active.rpcPath, JSON.stringify({ at: Date.now(), method, error: value.params }) + '\n');
    if (!value.method) pending.delete(value.id);
  }
  return originalReceive.call(this, value);
};

const fill = (text: string, fields: Record<string, unknown>) =>
  Object.entries(fields).reduce((value, [key, replacement]) => value.replaceAll('{{' + key + '}}', String(replacement)), text);
const unionMs = (intervals: number[][], start = 0, end = Infinity) => {
  const ordered = intervals
    .map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    left = 0,
    right = 0;
  for (const [a, b] of ordered) {
    if (a > right) {
      total += right - left;
      left = a;
      right = b;
    } else right = Math.max(right, b);
  }
  return total + right - left;
};
async function stage(row: BenchmarkRow, name: string, config: StageConfig, prompt: string, signal: AbortSignal) {
  const directory = join(runDir, row.id, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'prompt.md'), prompt);
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  const factory = row.variant === 'baseline' || values.ablation ? baselineTools : candidateTools;
  const started = performance.now();
  const fullService = await factory(config, combined);
  if (values.ablation && name === 'explore' && !fullService.tools.some((tool) => tool.name === 'browser_batch')) {
    await fullService.close();
    throw new Error('Ablation requires the frozen full implementation');
  }
  const service = values.ablation && row.variant === 'baseline' ? withoutBrowserBatch(fullService) : fullService;
  writeFileSync(join(directory, 'tool-definitions.json'), JSON.stringify(service.tools, null, 2));
  const intervals: number[][] = [];
  const stats: any = {
    toolCalls: 0,
    resultBytes: 0,
    providerResultBytes: 0,
    toolCounts: {},
    compactions: 0,
    usageUpdates: 0,
    rpcPath: join(directory, 'rpc-timing.jsonl'),
  };
  const wrapped: ToolService = {
    ...service,
    async call(tool, args, cancel) {
      if (stats.toolCalls >= 80) {
        controller.abort(new Error('Benchmark tool-call limit'));
        throw controller.signal.reason;
      }
      stats.toolCalls++;
      stats.toolCounts[tool] = (stats.toolCounts[tool] ?? 0) + 1;
      const start = performance.now();
      let result: any;
      try {
        result = await service.call(tool, args, cancel);
        stats.resultBytes += Buffer.byteLength(JSON.stringify(result));
        return result;
      } finally {
        const end = performance.now();
        intervals.push([start, end]);
        appendFileSync(
          join(directory, 'tools.jsonl'),
          JSON.stringify({
            at: Date.now(),
            tool,
            args,
            elapsedMs: end - start,
            result,
          }) + '\n',
        );
        emit({ run: row.id, stage: name, tool, calls: stats.toolCalls });
      }
    },
  };
  active = stats;
  let outcome: any;
  try {
    outcome = await runCodex(
      {
        prompt,
        cwd: directory,
        model,
        tools: [],
        allowedTools: [],
        transcriptPath: join(directory, 'transcript.jsonl'),
        signal: combined,
        onMetrics: (metrics: RunMetrics) => {
          stats.metrics = metrics;
          writeFileSync(join(directory, 'metrics.json'), JSON.stringify(metrics, null, 2));
        },
      },
      wrapped,
    );
    assert.equal(stats.resolved?.model, model, 'Resolved model drift');
    assert.equal(stats.resolved?.reasoningEffort, reasoning, 'Reasoning setting drift');
    assert.equal(stats.resolved?.serviceTier, 'default', 'Service tier drift');
    writeFileSync(join(directory, 'final.txt'), outcome.resultText);
    return lastJsonObject<any>(outcome.resultText);
  } finally {
    await service.close();
    stats.wallMs = performance.now() - started;
    stats.toolMs = unionMs(intervals, stats.turnStart ?? started, stats.turnEnd ?? performance.now());
    stats.providerAndOrchestrationMs = Math.max(0, (stats.turnEnd ?? performance.now()) - (stats.turnStart ?? started) - stats.toolMs);
    delete stats.rpcPath;
    row.stages[name] = stats;
    active = undefined;
    writeFileSync(join(directory, 'timing.json'), JSON.stringify(stats, null, 2));
  }
}

function flattenTests(report: any): any[] {
  return (report.suites ?? []).flatMap((s: any) => [
    ...(s.specs ?? []).flatMap((spec: any) => spec.tests.map((test: any) => ({ ...test, specTitle: spec.title }))),
    ...flattenTests(s),
  ]);
}
async function audit(row: BenchmarkRow, specDir: string, specFile: string) {
  const dir = join(runDir, row.id, 'assertion-audit');
  mkdirSync(dir);
  fixture.begin({
    id: row.id,
    workflow: row.workflow as Workflow,
    stage: 'audit',
  });
  const mutants = mutations(row.workflow as Workflow);
  const config = join(dir, 'playwright.config.ts'),
    output = join(dir, 'output'),
    resultPath = join(dir, 'results.json');
  writeFileSync(
    config,
    `export default ${JSON.stringify({ testDir: specDir, outputDir: output, timeout: 25_000, expect: { timeout: 1500 }, retries: 0, workers: values.ablation ? 1 : 3, reporter: [['json', { outputFile: resultPath }]], use: { baseURL: fixture.base, storageState: state, headless: true, launchOptions: { executablePath: chromium.executablePath() }, actionTimeout: 3000, navigationTimeout: 5000 }, projects: mutants.map((m) => ({ name: m.name, use: { extraHTTPHeaders: { 'x-benchmark-mutant': m.name } } })) }, null, 2)};`,
  );
  const result = await command('npx', ['playwright', 'test', '-c', config, specFile], {
    cwd: root,
    timeoutMs: 180_000,
    env: { ...process.env, E2E_OBSERVATION_RUN_DIR: '', E2E_CAPTIONS: '0' },
  });
  writeFileSync(join(dir, 'log.txt'), result.stdout + '\n' + result.stderr);
  const tests = existsSync(resultPath) ? flattenTests(JSON.parse(readFileSync(resultPath, 'utf8'))) : [];
  const checks = mutants.map((m) => {
    const matches = tests.filter((t) => t.projectName === m.name),
      test = matches[0],
      outcome = test?.results?.[0];
    const failedStep = outcome?.steps?.find((s: any) => s.error)?.title;
    const assertionFailure = /expect\(|Expected:|Received:/.test(outcome?.error?.message ?? '');
    const passed =
      matches.length === 1 &&
      test.results.length === 1 &&
      outcome.status === m.expected &&
      (m.expected === 'passed' || (failedStep?.startsWith(`Step ${m.step}:`) && assertionFailure));
    return {
      ...m,
      status: outcome?.status,
      failedStep,
      assertionFailure,
      passed,
      error: outcome?.error?.message?.slice(0, 1200),
    };
  });
  return {
    passed: checks.every((c) => c.passed),
    checks,
    elapsedMs: tests.reduce((n, t) => n + (t.results?.[0]?.duration ?? 0), 0),
  };
}

async function runOne(workflow: Workflow, repetition: number, variant: 'baseline' | 'candidate') {
  const id = `${workflow}-${repetition}-${variant}`,
    directory = join(runDir, id),
    variantRoot = variant === 'baseline' ? baselineRoot : candidateRoot;
  mkdirSync(join(directory, 'explore/video'), { recursive: true });
  mkdirSync(join(directory, 'codify'));
  const specDir = join(variantRoot, 'e2e/generated', basename(runDir) + '-' + id);
  mkdirSync(specDir, { recursive: true });
  const specFile = 'BENCH.spec.ts',
    specPath = join(specDir, specFile),
    casePath = join(directory, 'explore/case.json'),
    appContextPath = join(directory, 'context.md');
  const testCase = benchmarkCase(workflow);
  writeFileSync(casePath, JSON.stringify(testCase, null, 2));
  writeFileSync(
    appContextPath,
    'Disposable localhost fixture. /form is the profile editor; /wizard is checkout; /note is the note editor. /client-list is a harmless fixture landing route used by openPage. No login is needed. Labels and button names are stable. Use only the case route and exact expected values. All changes belong to this isolated browser.',
  );
  const hook = join(directory, 'explore/observe.cjs');
  writeFileSync(
    hook,
    `exports.default=({page})=>{require(${JSON.stringify(join(root, 'src/browser-observer.ts'))}).observeBrowser(page,${JSON.stringify({ runDir: directory, artifactDir: join(directory, 'explore'), stage: 'explore' })});};`,
  );
  const browserConfig = join(directory, 'explore/browser.json');
  writeFileSync(
    browserConfig,
    JSON.stringify({
      browser: {
        browserName: 'chromium',
        isolated: true,
        initPage: [hook],
        launchOptions: {
          headless: true,
          executablePath: chromium.executablePath(),
        },
        contextOptions: {
          storageState: state,
          viewport: { width: 1440, height: 900 },
          recordVideo: {
            dir: join(directory, 'explore/video'),
            size: { width: 1440, height: 900 },
          },
        },
      },
      outputDir: join(directory, 'explore/mcp-output'),
      testIdAttribute: 'data-testid',
    }),
  );
  writeReplayEnv(directory, specDir, specFile, fixture.base, 'bench', 'fixture', state);
  const row: BenchmarkRow = {
    id,
    workflow,
    repetition,
    variant,
    elapsedMs: 0,
    correct: false,
    errors: [],
    stages: {},
  };
  const started = performance.now(),
    signal = AbortSignal.timeout(deadlineMs);
  emit({ event: 'start', id, workflow, repetition, variant });
  try {
    fixture.begin({ id, workflow, stage: 'explore' });
    const explorationPrompt = readFileSync(join(variantRoot, 'prompts/verify-case.md'), 'utf8');
    const prompt = fill(values.ablation && variant === 'baseline' ? withoutBatchGuidance(explorationPrompt) : explorationPrompt, {
      BASE_URL: fixture.base,
      CASE_JSON: JSON.stringify(testCase, null, 2),
      RELATED_CASES: '(none)',
      APP_CONTEXT: readFileSync(appContextPath, 'utf8'),
      CASE_ID: testCase.id,
      RUN_ID: id,
    });
    const report = await stage(
      row,
      'explore',
      {
        browserConfig,
        actionsPath: join(directory, 'explore/actions.js'),
        runDir: directory,
      },
      prompt,
      signal,
    );
    writeFileSync(join(directory, 'explore/report.json'), JSON.stringify(report ?? null, null, 2));
    row.errors.push(
      ...verifyExploration(
        workflow,
        report,
        fixture.observations.filter((o) => o.id === id),
      ),
    );
    if (!report || !Array.isArray(report.steps)) throw new Error('Exploration did not produce a usable report');
    fixture.begin({ id, workflow, stage: 'codify' });
    const inputs = {
      CASE_PATH: casePath,
      REPORT_PATH: join(directory, 'explore/report.json'),
      ACTIONS_PATH: join(directory, 'explore/actions.js'),
      NETWORK_PATH: join(directory, 'explore/network.json'),
      APP_CONTEXT_PATH: appContextPath,
      HELPER_PATH: join(variantRoot, 'e2e/qase-step.ts'),
      SPEC_PATH: specPath,
      RUN_DIR: directory,
      PROJECT: 'BENCH',
      CASE_ID: testCase.id,
      MAX_ATTEMPTS: 2,
    };
    const codified = await stage(
      row,
      'codify',
      {
        specPath,
        runDir: directory,
        maxAttempts: 2,
        readFiles: [
          inputs.CASE_PATH,
          inputs.REPORT_PATH,
          inputs.ACTIONS_PATH,
          inputs.NETWORK_PATH,
          inputs.APP_CONTEXT_PATH,
          inputs.HELPER_PATH,
        ],
      },
      fill(readFileSync(join(variantRoot, 'prompts/codify-case.md'), 'utf8'), inputs),
      signal,
    );
    writeFileSync(join(directory, 'codify/result.json'), JSON.stringify(codified ?? null, null, 2));
    const expected = workflow === 'persistence' ? 'failed' : 'passed';
    if (codified?.outcome !== (expected === 'failed' ? 'failed-as-expected' : 'passed')) row.errors.push('Incorrect codification outcome');
    if (!existsSync(specPath)) throw new Error('No generated spec');
    const lastPath = join(directory, 'codify/last-attempt.json');
    const last = existsSync(lastPath) ? JSON.parse(readFileSync(lastPath, 'utf8')) : undefined;
    if (!last || last.specHash !== hash(specPath) || last.result?.status !== expected)
      row.errors.push('Spec did not match a completed stabilization attempt');
    fixture.begin({ id, workflow, stage: 'replay' });
    const result = await replay({
      runDir: directory,
      label: 'benchmark',
      specDir,
      specFile,
      base: fixture.base,
      slot: 'bench',
      role: 'fixture',
      storageState: state,
      slowMo: 0,
      signal,
    });
    (row as any).replay = result;
    if (result.status !== expected || (expected === 'failed' && !result.failedStep?.startsWith('Step 2:')))
      row.errors.push('Incorrect independent replay result');
    row.elapsedMs = performance.now() - started;
    // Mutation audit is an independent quality guard, explicitly outside primary workflow timing.
    row.audit = await audit(row, specDir, specFile);
    if (!row.audit.passed) row.errors.push('Generated assertions did not pass the independent mutation audit');
    row.correct = row.errors.length === 0;
  } catch (error) {
    row.errors.push(String(error));
    row.elapsedMs ||= performance.now() - started;
  }
  writeFileSync(join(directory, 'result.json'), JSON.stringify(row, null, 2));
  rows.push(row);
  writeFileSync(join(runDir, 'results.json'), JSON.stringify(rows, null, 2));
  writeFileSync(
    join(runDir, 'analysis.json'),
    JSON.stringify(summarizeModelBenchmark(rows, deadlineMs, selected.length * repeats), null, 2),
  );
  emit({
    event: 'complete',
    id,
    correct: row.correct,
    seconds: Math.round(row.elapsedMs / 1000),
    errors: row.errors,
  });
}

try {
  const rpc = await codexConnection();
  let runtime: any;
  try {
    const account = await rpc.request('account/read', { refreshToken: false });
    assert.equal(account.account?.type, 'chatgpt');
    const catalog = await rpc.request('model/list', {
      limit: 100,
      includeHidden: true,
    });
    runtime = catalog.data.find((entry: any) => entry.model === model);
    assert(runtime, 'Requested model unavailable');
  } finally {
    await rpc.close();
  }
  const rng = random(seed);
  const plan = selected.flatMap((workflow, wi) =>
    Array.from({ length: repeats }, (_, repetition) => ({
      workflow,
      repetition,
      order: (repetition + wi) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
    })),
  );
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  const paths = [
    'src/stage-tools.ts',
    'src/providers/codex.ts',
    'src/runner.ts',
    'src/stage-mcp.ts',
    'prompts/verify-case.md',
    'prompts/codify-case.md',
    'src/network.ts',
    'src/replay.ts',
    'src/usage.ts',
    'e2e/qase-step.ts',
    'e2e/playwright.config.ts',
    'package-lock.json',
  ];
  const manifest = {
    createdAt: new Date().toISOString(),
    pilot: values.pilot,
    comparison: values.ablation ? 'revised-without-browser-batch-vs-revised-full' : 'original-vs-revised',
    variants: values.ablation
      ? {
          baseline: 'Revised tools and prompts, browser_batch omitted',
          candidate: 'Same revised tools and prompts, browser_batch available',
        }
      : {
          baseline: 'Original tools and prompts',
          candidate: 'Revised tools and prompts',
        },
    auditWorkers: values.ablation ? 1 : 3,
    model,
    reasoning,
    serviceTier: 'default',
    deadlineMs,
    maxToolCallsPerStage: 80,
    maxAttempts: 2,
    repeats,
    seed,
    plan,
    runtimeVersion: execFileSync('codex', ['--version'], {
      encoding: 'utf8',
    }).trim(),
    node: process.version,
    baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: baselineRoot,
      encoding: 'utf8',
    }).trim(),
    hashes: {
      baseline: Object.fromEntries(
        [...paths, ...(values.ablation ? ['src/stage-browser.ts', 'src/stage-results.ts'] : [])].map((p) => [
          p,
          hash(join(baselineRoot, p)),
        ]),
      ),
      candidate: Object.fromEntries(
        [...paths, 'src/stage-browser.ts', 'src/stage-results.ts'].map((p) => [p, hash(join(candidateRoot, p))]),
      ),
      harness: Object.fromEntries(
        [
          'tests/fixtures/model-benchmark.ts',
          'tests/model-batching-benchmark.ts',
          'tests/model-benchmark-analysis.ts',
          'tests/model-benchmark-variants.ts',
        ].map((p) => [p, hash(join(root, p))]),
      ),
    },
    acceptance: {
      medianPairedImprovement: 0.15,
      pairedBootstrap95LowerBoundAbove: 0,
      allCandidateRunsMeetOracleAndAudit: true,
    },
    notes: [
      values.ablation
        ? 'Both arms use the same revised implementation; control hides browser_batch and removes only its prompt guidance. Common Codex adapter and replay orchestration.'
        : 'Original and candidate stage services and prompts; common unchanged Codex provider adapter and replay orchestration.',
      'Models select tools freely, including existing code execution. No forced baseline single-action strategy.',
      'Fresh ephemeral provider sessions and browser contexts; paired run order alternates and workflow pairs are shuffled.',
      'Time from exploration service startup through independent replay and packaging; excludes post-run mutation audit.',
      'Provider-and-orchestration residual excludes the union of tool callback intervals. It is not a direct inference-only latency measurement.',
      'No failed run is discarded. Mutation audit runs the generated spec against each assertion defect with 1.5s expectation timeout; production stabilization/replay settings are unchanged.',
      ...(values.ablation
        ? [
            'Audit workers are serialized in both arms to reduce contention; timeouts, assertions, retries and quality scoring are unchanged. Keep generic batching if it meets the predeclared target. If it does not and control qualification is no worse, select the simpler interface without claiming equivalence; otherwise investigate the quality difference before selecting.',
          ]
        : []),
    ],
  };
  if (values.resume) {
    const prior = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    assert.equal(prior.comparison, manifest.comparison, 'Comparison mode changed since the experiment began');
    assert.deepEqual(prior.hashes, manifest.hashes, 'Code changed since the experiment began');
    assert.deepEqual(prior.plan, manifest.plan, 'The resumed experiment must use the original plan');
    // An interrupted model workflow is a failure, not a fresh chance at the same pair.
    // Retain any completed stage measurements and never replay its uncertain actions.
    const events = readFileSync(join(runDir, 'progress.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const event of events.filter((e) => e.event === 'start')) {
      if (rows.some((r) => r.id === event.id)) continue;
      const resultPath = join(runDir, event.id, 'result.json');
      const stages: Record<string, any> = {};
      for (const name of ['explore', 'codify']) {
        const path = join(runDir, event.id, name, 'timing.json');
        if (existsSync(path)) stages[name] = JSON.parse(readFileSync(path, 'utf8'));
      }
      const row = existsSync(resultPath)
        ? JSON.parse(readFileSync(resultPath, 'utf8'))
        : {
            id: event.id,
            workflow: event.workflow,
            repetition: event.repetition,
            variant: event.variant,
            elapsedMs: deadlineMs,
            correct: false,
            stages,
            errors: ['Experiment interrupted before this workflow completed; retained as a failure without rerunning it.'],
          };
      rows.push(row);
      writeFileSync(resultPath, JSON.stringify(row, null, 2));
    }
    writeFileSync(join(runDir, 'results.json'), JSON.stringify(rows, null, 2));
  } else writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  emit({
    event: 'experiment',
    runDir,
    model,
    runs: plan.length * 2,
    pilot: values.pilot,
  });
  for (const pair of plan)
    for (const variant of pair.order as ('baseline' | 'candidate')[]) {
      if (rows.some((r) => r.workflow === pair.workflow && r.repetition === pair.repetition && r.variant === variant)) continue;
      await runOne(pair.workflow, pair.repetition, variant);
    }
  console.log(
    JSON.stringify(
      {
        runDir,
        analysis: summarizeModelBenchmark(rows, deadlineMs, selected.length * repeats),
      },
      null,
      2,
    ),
  );
} finally {
  active = undefined;
  Rpc.prototype.send = originalSend;
  Rpc.prototype.receive = originalReceive;
  await fixture.close();
}
