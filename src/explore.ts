import { Effect } from 'effect';
import { runEffect } from './runtime/effect.ts';
import { CheckerLive } from './runtime/services.ts';
import type { RunPricing } from './pricing.ts';
import { assertRunnable, type TestCase } from './cases.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { lastJsonObject, type ClaudeOutcome } from './claude.ts';
import { statePath } from './login.ts';
import { loadCaseWithRelatedEffect, summarizeRelated, type QaseCase } from './qase.ts';

import { runAgentEffect } from './runner.ts';
import type { Target } from './providers/index.ts';
import type { RunMetrics } from './usage.ts';
import { z } from 'zod';

// Stage 1: an agent verifies a Qase case step by step in a live browser (Playwright MCP) and reports evidence.

export type StepVerdict = { position: number; verdict: 'pass' | 'fail' | 'blocked'; evidence: string; inferred?: boolean; check?: string };
export type ExploreReport = {
  caseId: number;
  verdict: 'pass' | 'fail' | 'blocked';
  steps: StepVerdict[];
  dataChanges?: string;
  notes?: string;
};

export type ExploreOptions = {
  caseSnapshot?: TestCase;
  project: string;
  caseId: number;
  base: string;
  role: string;
  slot: string;
  model: string;
  runDir: string;
  headed?: boolean;
  storageState?: string;
  target?: Target;
  pricing?: RunPricing;
  signal?: AbortSignal;
  onMetrics?: (metrics: RunMetrics) => void;
  log?: (line: string) => void;
};

const root = new URL('..', import.meta.url).pathname;

// Every browser action Playwright MCP executed, as code, in order. The codify stage builds the spec from it.
export const actionLog = (events: ClaudeOutcome['events']) => {
  const code: string[] = [];
  for (const e of events) {
    if (e.type !== 'user') continue;
    for (const part of (e as { message: { content: unknown[] } }).message.content) {
      const p = part as { type?: string; content?: string | { text?: string }[] };
      if (p.type !== 'tool_result') continue;
      const text = typeof p.content === 'string' ? p.content : (p.content ?? []).map((c) => c.text ?? '').join('\n');
      const match = text.match(/### Ran Playwright code\s*```(?:js|ts)?\n([\s\S]*?)```/);
      const url = text.match(/- Page URL: (\S+)/)?.[1];
      if (match) code.push(`${match[1].trim()}${url ? `  // → ${url}` : ''}`);
    }
  }
  return code;
};

export const exploreEffect = (opts: ExploreOptions) =>
  Effect.gen(function* () {
    const state = opts.storageState ?? statePath(opts.slot, opts.role);
    if (!existsSync(state))
      throw new Error(
        `No session for slot ${opts.slot}/${opts.role}. Run: npm run login -- --slot ${opts.slot} --role ${opts.role} --base ${opts.base}`,
      );
    const dir = join(opts.runDir, 'explore');
    mkdirSync(join(dir, 'video'), { recursive: true });

    const { testCase, related } = yield* loadCaseWithRelatedEffect(opts.project, opts.caseId, opts.caseSnapshot);
    assertRunnable(testCase);

    writeFileSync(join(dir, 'case.json'), JSON.stringify(testCase, null, 2));

    const observerPath = join(dir, 'observe-page.cjs');
    writeFileSync(
      observerPath,
      `exports.default = ({ page }) => { require(${JSON.stringify(join(root, 'src/browser-observer.ts'))}).observeBrowser(page, ${JSON.stringify({ runDir: opts.runDir, artifactDir: dir, stage: 'explore' })}); };`,
    );

    const mcpConfigPath = join(dir, 'playwright-mcp.config.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          browser: {
            browserName: 'chromium',
            isolated: true,
            initPage: [observerPath],
            launchOptions: { headless: !opts.headed },
            contextOptions: {
              storageState: state,
              viewport: { width: 1440, height: 900 },
              recordVideo: { dir: join(dir, 'video'), size: { width: 1440, height: 900 } },
            },
          },
          outputDir: join(dir, 'mcp-output'),
          testIdAttribute: 'data-testid',
        },
        null,
        2,
      ),
    );

    const runId = opts.runDir.split('/').pop()!;
    const prompt = readFileSync(join(root, 'prompts/verify-case.md'), 'utf8')
      .replaceAll('{{BASE_URL}}', opts.base)
      .replaceAll('{{CASE_JSON}}', JSON.stringify(testCase satisfies QaseCase, null, 2))
      .replaceAll('{{RELATED_CASES}}', related.length ? summarizeRelated(related) : '(none)')
      .replaceAll('{{APP_CONTEXT}}', readFileSync(join(root, 'context/sample-app.md'), 'utf8'))
      .replaceAll('{{CASE_ID}}', String(opts.caseId))
      .replaceAll('{{RUN_ID}}', runId);
    writeFileSync(join(dir, 'prompt.md'), prompt);

    const outcome = yield* runAgentEffect({
      target: opts.target,
      pricing: opts.pricing,
      signal: opts.signal,
      onMetrics: opts.onMetrics,
      stageConfig: { browserConfig: mcpConfigPath, actionsPath: join(dir, 'actions.js'), runDir: opts.runDir },
      prompt,
      cwd: dir,
      model: opts.model,
      tools: [''],
      allowedTools: ['mcp__playwright'],
      transcriptPath: join(dir, 'transcript.jsonl'),
      log: opts.log,
    });

    const schema = z.object({
      caseId: z.literal(opts.caseId),
      verdict: z.enum(['pass', 'fail', 'blocked']),
      steps: z.array(
        z.object({
          position: z.number().int(),
          verdict: z.enum(['pass', 'fail', 'blocked']),
          evidence: z.string().min(1),
          inferred: z.boolean().optional(),
          check: z.string().optional(),
        }),
      ),
      dataChanges: z.string().optional(),
      notes: z.string().optional(),
    });
    const report = schema.parse(lastJsonObject<ExploreReport>(outcome.resultText));
    const expected = testCase.steps.map((s) => s.position).sort((a, b) => a - b);
    if (JSON.stringify(report.steps.map((s) => s.position).sort((a, b) => a - b)) !== JSON.stringify(expected))
      throw new Error('REPORT_INVALID: report must cover every case step exactly once');
    if (report.verdict === 'pass' && report.steps.some((s) => s.verdict !== 'pass'))
      throw new Error('REPORT_INVALID: passing report contains non-passing steps');
    if (report.verdict === 'fail' && !report.steps.some((s) => s.verdict === 'fail'))
      throw new Error('REPORT_INVALID: failing report contains no failed step');
    const actions = existsSync(join(dir, 'actions.js'))
      ? readFileSync(join(dir, 'actions.js'), 'utf8').split('\n')
      : actionLog(outcome.events);
    writeFileSync(join(dir, 'report.json'), report ? JSON.stringify(report, null, 2) : outcome.resultText);
    writeFileSync(join(dir, 'actions.js'), actions.join('\n'));
    const metrics = { ...outcome.metrics, videos: readdirSync(join(dir, 'video')) };
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    return { testCase, report, actions, metrics };
  });
export const explore = (opts: ExploreOptions) => runEffect(exploreEffect(opts).pipe(Effect.provide(CheckerLive)), opts.signal);

export const newRunDir = (project: string, caseId: number, slot: string, label = '') => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const unique = Math.random().toString(36).slice(2, 5);
  const dir = join(root, 'runs', `${stamp}-${project}-${caseId}-slot${slot}${label ? `-${label}` : ''}-${unique}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      case: { type: 'string' },
      project: { type: 'string', default: 'DEMO' },
      base: { type: 'string', default: 'http://localhost:4001' },
      role: { type: 'string', default: 'eugene' },
      slot: { type: 'string', default: '1' },
      model: { type: 'string', default: 'sonnet' },
      label: { type: 'string', default: '' },
      headed: { type: 'boolean', default: false },
    },
  });
  if (!values.case) throw new Error('Usage: node src/explore.ts --case <id>');
  const caseId = Number(values.case);
  const runDir = newRunDir(values.project!, caseId, values.slot!, values.label);
  console.log(`Explore ${values.project}-${caseId} → ${runDir}`);
  const { report, metrics } = await explore({
    ...values,
    caseId,
    runDir,
    project: values.project!,
    base: values.base!,
    role: values.role!,
    slot: values.slot!,
    model: values.model!,
    log: (l) => console.log(`  ${l}`),
  });
  console.log(`\nVerdict: ${report?.verdict ?? 'unparsed'}`);
  for (const s of report?.steps ?? [])
    console.log(`  ${s.position}. ${s.verdict}${s.inferred ? ' (inferred)' : ''}: ${s.evidence.slice(0, 160)}`);
  console.log(
    `Reported cost ${metrics.costUsd === null ? 'unavailable' : '$' + metrics.costUsd.toFixed(3)} · ${metrics.turns} turns · ${metrics.toolCalls} tool calls · ${(metrics.wallMs / 1000).toFixed(0)}s`,
  );
}
