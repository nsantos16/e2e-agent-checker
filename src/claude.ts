import { Effect } from 'effect';
import { runEffect } from './runtime/effect.ts';
import { appendFileSync, writeFileSync } from 'node:fs';
import { priceClaudeResult, type RunPricing } from './pricing.ts';
import { commandEffect, ProcessRunnerLive } from './process.ts';
import { claudeUsage, emptyUsage, mergeUsage, type RunMetrics } from './usage.ts';

import type { ProviderInstance, Target } from './providers/schema.ts';
import { expandPath, instanceEnvironment } from './providers/instances.ts';
import { redactProviderEvent } from './providers/telemetry.ts';
import { RunError, nativeFailure } from './providers/errors.ts';

export type ClaudeRun = {
  instance?: ProviderInstance;
  target?: Target;
  prompt: string;
  cwd: string;
  model: string;
  pricing?: RunPricing;
  tools: string[];
  allowedTools: string[];
  addDirs?: string[];
  mcpConfigPath?: string;
  transcriptPath: string;
  signal?: AbortSignal;
  onMetrics?: (metrics: RunMetrics) => void;
  log?: (line: string) => void;
};
export type ClaudeOutcome = { exitCode: number; resultText: string; events: Record<string, any>[]; metrics: RunMetrics };
export const runClaudeEffect = (run: ClaudeRun) =>
  Effect.scoped(
    Effect.gen(function* () {
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        run.model,
        '--restricted',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--settings',
        '{"disableAllHooks":true,"forceLoginMethod":"claudeai"}',
        ...(run.target?.options?.effort ? ['--effort', run.target.options.effort] : []),
        '--permission-mode',
        'dontAsk',
        '--tools',
        run.tools.join(','),
        '--allowedTools',
        run.allowedTools.join(','),
        ...(run.addDirs ?? []).flatMap((d) => ['--add-dir', d]),
        ...(run.mcpConfigPath ? ['--mcp-config', run.mcpConfigPath] : []),
        '--strict-mcp-config',
      ];
      const started = Date.now(),
        events: Record<string, any>[] = [],
        messages = new Map<string, ReturnType<typeof claudeUsage>>();
      const metrics: RunMetrics = {
        target: run.target,
        costUsd: null,
        turns: 0,
        toolCalls: 0,
        wallMs: 0,
        models: [],
        usage: emptyUsage('claude'),
      };
      writeFileSync(run.transcriptPath, '', { mode: 0o600 });
      const update = () => {
        metrics.wallMs = Date.now() - started;
        run.onMetrics?.({ ...metrics });
      };
      update();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (metrics.usage.status === 'pending') metrics.usage.status = 'unavailable';
          update();
        }),
      );
      const result = yield* commandEffect(run.instance ? expandPath(run.instance.binaryPath) : 'claude', args, {
        env: run.instance ? instanceEnvironment(run.instance) : undefined,
        cwd: run.cwd,
        signal: run.signal,
        input: run.prompt,
        onLine: (line) => {
          let e: any;
          try {
            e = JSON.parse(line);
          } catch {
            return;
          }
          if (e.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected') {
            const reset = e.rate_limit_info.resetsAt;
            metrics.limits = [{ name: 'Claude subscription', exhausted: true, ...(typeof reset === 'number' ? { resetsAt: reset } : {}) }];
            update();
            throw new RunError(
              'USAGE_EXHAUSTED',
              'Claude reported an exhausted subscription limit. Retry after the native reset.',
              typeof reset === 'number' ? reset : undefined,
            );
          }
          events.push(e);
          appendFileSync(run.transcriptPath, redactProviderEvent(e) + '\n');
          if (e.type === 'assistant') {
            if (e.message?.id && e.message.usage) {
              const usage = claudeUsage(e.message.usage);
              messages.set(e.message.id, run.pricing && e.message.model ? run.pricing.price(usage, e.message.model) : usage);
              metrics.usage = mergeUsage([...messages.values()]);
            }
            if (e.message?.model) metrics.models = [...new Set([...metrics.models, e.message.model])];
            for (const part of e.message?.content ?? [])
              if (part.type === 'tool_use') {
                metrics.toolCalls++;
                run.log?.(`→ ${part.name}`);
              }
          }
          if (e.type === 'result') {
            metrics.usage = priceClaudeResult(
              claudeUsage(e.usage ?? {}, e.total_cost_usd, !e.is_error),
              e.modelUsage,
              metrics.models,
              run.pricing,
            );
            metrics.costUsd = metrics.usage.providerReportedCostUsd;
            metrics.turns = e.num_turns ?? 0;
            if (Object.keys(e.modelUsage ?? {}).length) metrics.models = Object.keys(e.modelUsage);
          }
          update();
        },
      });
      const final = events.findLast((e) => e.type === 'result');
      if (result.code !== 0 || !final || final.is_error)
        throw nativeFailure(final?.errors?.join('; ') ?? result.stderr ?? 'Claude run failed');
      return { exitCode: result.code, resultText: final.result ?? '', events, metrics };
    }),
  );
export const runClaude = (run: ClaudeRun): Promise<ClaudeOutcome> =>
  runEffect(runClaudeEffect(run).pipe(Effect.provide(ProcessRunnerLive)), run.signal);
export const lastJsonObject = <T>(text: string): T | undefined => {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const candidate of [...fenced.reverse(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* next candidate */
    }
  }
};
