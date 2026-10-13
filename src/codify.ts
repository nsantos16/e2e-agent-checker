import { Effect } from 'effect';
import { runEffect, sdk } from './runtime/effect.ts';
import { CheckerLive } from './runtime/services.ts';
import type { RunPricing } from './pricing.ts';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastJsonObject } from './claude.ts';
import { statePath } from './login.ts';

import { runAgentEffect } from './runner.ts';
import type { Target } from './providers/index.ts';
import type { RunMetrics } from './usage.ts';
import { z } from 'zod';
import { createHash } from 'node:crypto';

// Stage 2: an agent writes a Playwright spec from the explore run and stabilises it against the same build.

export type CodifyResult = {
  specPath: string;
  attempts: number;
  outcome: 'passed' | 'failed-as-expected' | 'could-not-stabilize';
  failingStep: number | null;
  notes?: string;
};

const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const root = new URL('..', import.meta.url).pathname;

export const specLocation = (runDir: string, project: string, caseId: number) => {
  const runId = runDir.split('/').pop()!;
  const specDir = join(root, 'e2e/generated', runId);
  return { specDir, specFile: `${project}-${caseId}.spec.ts`, specPath: join(specDir, `${project}-${caseId}.spec.ts`) };
};

// Points scripts/try-spec.sh (and replay) at a slot. Values only, no secrets: the session file path, not its contents.
export const writeReplayEnv = (
  runDir: string,
  specDir: string,
  specFile: string,
  base: string,
  slot: string,
  role: string,
  storageState?: string,
) =>
  writeFileSync(
    join(runDir, 'replay.env'),
    [
      `E2E_SPEC_DIR=${quote(specDir)}`,
      `E2E_SPEC_FILE=${quote(specFile)}`,
      `E2E_BASE_URL=${quote(base)}`,
      `E2E_STORAGE_STATE=${quote(storageState ?? statePath(slot, role))}`,
    ].join('\n') + '\n',
  );

export type CodifyOptions = {
  project: string;
  caseId: number;
  runDir: string;
  base: string;
  slot: string;
  role: string;
  storageState?: string;
  model: string;
  target?: Target;
  pricing?: RunPricing;
  signal?: AbortSignal;
  onMetrics?: (metrics: RunMetrics) => void;
  maxAttempts?: number;
  log?: (l: string) => void;
};
export const codifyEffect = (opts: CodifyOptions) =>
  Effect.gen(function* () {
    const dir = join(opts.runDir, 'codify');
    mkdirSync(dir, { recursive: true });
    const { specDir, specFile, specPath } = specLocation(opts.runDir, opts.project, opts.caseId);
    mkdirSync(specDir, { recursive: true });
    writeReplayEnv(opts.runDir, specDir, specFile, opts.base, opts.slot, opts.role, opts.storageState);

    const capturedCase = join(opts.runDir, 'explore/case.json');
    const casePath = existsSync(capturedCase) ? capturedCase : join(root, 'fixtures/qase', `${opts.project}-${opts.caseId}.json`);
    const fill = (s: string) =>
      s
        .replaceAll('{{CASE_PATH}}', casePath)
        .replaceAll('{{REPORT_PATH}}', join(opts.runDir, 'explore/report.json'))
        .replaceAll('{{NETWORK_PATH}}', join(opts.runDir, 'explore/network.json'))
        .replaceAll('{{ACTIONS_PATH}}', join(opts.runDir, 'explore/actions.js'))
        .replaceAll('{{APP_CONTEXT_PATH}}', join(root, 'context/sample-app.md'))
        .replaceAll('{{HELPER_PATH}}', join(root, 'e2e/qase-step.ts'))
        .replaceAll('{{SPEC_PATH}}', specPath)
        .replaceAll('{{RUN_DIR}}', opts.runDir)
        .replaceAll('{{PROJECT}}', opts.project)
        .replaceAll('{{CASE_ID}}', String(opts.caseId))
        .replaceAll('{{MAX_ATTEMPTS}}', String(opts.maxAttempts ?? 8));
    const prompt = fill(readFileSync(join(root, 'prompts/codify-case.md'), 'utf8'));
    writeFileSync(join(dir, 'prompt.md'), prompt);

    const outcome = yield* runAgentEffect({
      target: opts.target,
      pricing: opts.pricing,
      signal: opts.signal,
      onMetrics: opts.onMetrics,
      stageConfig: {
        specPath,
        runDir: opts.runDir,
        maxAttempts: opts.maxAttempts,
        readFiles: [
          casePath,
          join(opts.runDir, 'explore/report.json'),
          join(opts.runDir, 'explore/actions.js'),
          join(opts.runDir, 'explore/network.json'),
          join(root, 'context/sample-app.md'),
          join(root, 'e2e/qase-step.ts'),
        ],
      },
      prompt,
      cwd: root,
      model: opts.model,
      tools: [''],
      allowedTools: ['mcp__stage'],
      transcriptPath: join(dir, 'transcript.jsonl'),
      log: opts.log,
    });
    const result = z
      .object({
        specPath: z.literal(specPath),
        attempts: z
          .number()
          .int()
          .min(0)
          .max(opts.maxAttempts ?? 8),
        outcome: z.enum(['passed', 'failed-as-expected', 'could-not-stabilize']),
        failingStep: z.number().int().nullable(),
        notes: z.string().optional(),
      })
      .parse(lastJsonObject<CodifyResult>(outcome.resultText));
    const attemptsFile = join(dir, 'attempts.json');
    result.attempts = existsSync(attemptsFile) ? JSON.parse(readFileSync(attemptsFile, 'utf8')).attempts : 0;
    if (result.outcome !== 'could-not-stabilize' && (!existsSync(specPath) || result.attempts === 0))
      throw new Error('REPORT_INVALID: successful codification requires a saved spec and a test attempt');
    if (result.outcome !== 'could-not-stabilize') {
      const last = JSON.parse(readFileSync(join(dir, 'last-attempt.json'), 'utf8'));
      const hash = createHash('sha256').update(readFileSync(specPath)).digest('hex');
      if (
        last.specHash !== hash ||
        !last.result ||
        (result.outcome === 'passed' ? last.code !== 0 || last.result.status !== 'passed' : last.result.status !== 'failed')
      )
        throw new Error('REPORT_INVALID: reported outcome does not match the last tested spec');
    }
    writeFileSync(join(dir, 'result.json'), result ? JSON.stringify(result, null, 2) : outcome.resultText);
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(outcome.metrics, null, 2));
    if (existsSync(specPath)) copyFileSync(specPath, join(dir, specFile));
    return { result, metrics: outcome.metrics, specPath, specDir, specFile };
  });
export const codify = (opts: CodifyOptions) => runEffect(codifyEffect(opts).pipe(Effect.provide(CheckerLive)), opts.signal);
