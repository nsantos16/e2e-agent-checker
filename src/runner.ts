import { Effect } from 'effect';
import { deadline, runEffect } from './runtime/effect.ts';
import { CheckerLive } from './runtime/services.ts';
import { createRunPricingEffect } from './pricing.ts';
import { join, dirname } from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import { runClaudeEffect, type ClaudeRun } from './claude.ts';
import { preflightEffect, type Target } from './providers/index.ts';
import { runCodexEffect } from './providers/codex.ts';
import { stageToolsEffect, type StageConfig } from './stage-tools.ts';
const root = new URL('..', import.meta.url).pathname;
export type AgentRun = ClaudeRun & {
  target?: Target;
  stageConfig: StageConfig;
};
export const runAgentEffect = (input: AgentRun) =>
  Effect.scoped(
    Effect.gen(function* () {
      let run = input;

      const onMetrics = run.onMetrics;
      run = {
        ...run,
        onMetrics: (m) => {
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
      yield* preflightEffect(target);
      run.signal?.throwIfAborted();
      run.pricing ??= yield* createRunPricingEffect(run.stageConfig.runDir ?? dirname(dirname(run.transcriptPath)));
      run.signal?.throwIfAborted();
      if (target.provider === 'codex') {
        const service = yield* stageToolsEffect(run.stageConfig, run.signal);
        return yield* runCodexEffect({ ...run, model: target.model }, service);
      }
      const path = join(dirname(run.transcriptPath), 'stage-config.json');
      writeFileSync(path, JSON.stringify(run.stageConfig));
      const mcp = join(dirname(run.transcriptPath), 'runtime-mcp.json');
      writeFileSync(
        mcp,
        JSON.stringify({
          mcpServers: {
            stage: {
              command: process.execPath,
              args: [join(root, 'src/stage-mcp.ts'), path],
            },
          },
        }),
      );
      return yield* runClaudeEffect({
        ...run,
        model: target.model,
        cwd: dirname(run.transcriptPath),
        tools: [''],
        allowedTools: ['mcp__stage'],
        addDirs: [],
        mcpConfigPath: mcp,
      });
    }),
  ).pipe((effect) => (input.signal ? effect : deadline(effect, 20 * 60_000)));
export const runAgent = (run: AgentRun) => runEffect(runAgentEffect(run).pipe(Effect.provide(CheckerLive)), run.signal);
