import { Cause, Effect } from 'effect';
import { deadline, runEffect } from './runtime/effect.ts';
import { CheckerLive } from './runtime/services.ts';
import { createRunPricingEffect } from './pricing.ts';
import { join, dirname } from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import type { ClaudeRun } from './claude.ts';
import { preflightEffect, type Target } from './providers/index.ts';
import { harnesses } from './providers/adapters.ts';
import { nativeFailure } from './providers/errors.ts';
import { type StageConfig } from './stage-tools.ts';
export type AgentRun = ClaudeRun & {
  target?: Target;
  stageConfig?: StageConfig;
};
export const runAgentEffect = (input: AgentRun) =>
  Effect.scoped(
    Effect.gen(function* () {
      let run = input;

      const onMetrics = run.onMetrics;
      run = {
        ...run,
        stageConfig: run.stageConfig
          ? { ...run.stageConfig, runDir: run.stageConfig.runDir ?? dirname(dirname(run.transcriptPath)) }
          : undefined,
        onMetrics: (m) => {
          m.target = run.target;
          writeFileSync(join(dirname(run.transcriptPath), 'metrics.json'), JSON.stringify(m, null, 2));
          appendFileSync(join(dirname(run.transcriptPath), 'metrics.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...m }) + '\n');
          onMetrics?.(m);
        },
      };
      const target = run.target ?? {
        provider: 'claude-code',
        model: run.model,
        authMode: 'subscription',
      };
      const selected = yield* preflightEffect(target);
      run.target = selected.target;
      run.signal?.throwIfAborted();
      run.pricing ??= yield* createRunPricingEffect(run.stageConfig?.runDir ?? dirname(dirname(run.transcriptPath)));
      run.signal?.throwIfAborted();
      return yield* harnesses[target.provider]
        .start({ ...run, target: selected.target }, selected.instance, selected.target)
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(nativeFailure(Cause.squash(cause))),
          ),
        );
    }),
  ).pipe((effect) => (input.signal ? effect : deadline(effect, 20 * 60_000)));
export const runAgent = (run: AgentRun) => runEffect(runAgentEffect(run).pipe(Effect.provide(CheckerLive)), run.signal);

// Shared selection for summaries/narration text; speech credentials are a separate capability.
export const runNativeText = (run: Omit<AgentRun, 'stageConfig' | 'tools' | 'allowedTools' | 'mcpConfigPath'>) =>
  runAgent({ ...run, tools: [], allowedTools: [] });
