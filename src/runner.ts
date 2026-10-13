import { createRunPricing } from './pricing.ts';
import { join, dirname } from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import { runClaude, type ClaudeRun } from './claude.ts';
import { preflight, type Target } from './providers/index.ts';
import { runCodex } from './providers/codex.ts';
import { stageTools, type StageConfig } from './stage-tools.ts';
const root = new URL('..', import.meta.url).pathname;
export async function runAgent(run: ClaudeRun & { target?: Target; stageConfig: StageConfig }) {
  run = { ...run, signal: run.signal ?? AbortSignal.timeout(20 * 60_000) };
  const onMetrics = run.onMetrics;
  run = {
    ...run,
    onMetrics: (m) => {
      writeFileSync(join(dirname(run.transcriptPath), 'metrics.json'), JSON.stringify(m, null, 2));
      appendFileSync(join(dirname(run.transcriptPath), 'metrics.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...m }) + '\n');
      onMetrics?.(m);
    },
  };
  const target = run.target ?? { provider: 'claude-code', model: run.model, authMode: 'subscription' };
  await preflight(target);
  run.signal?.throwIfAborted();
  run.pricing ??= await createRunPricing(run.stageConfig.runDir ?? dirname(dirname(run.transcriptPath)));
  run.signal?.throwIfAborted();
  if (target.provider === 'codex') {
    const service = await stageTools(run.stageConfig, run.signal);
    try {
      return await runCodex({ ...run, model: target.model }, service);
    } finally {
      await service.close();
    }
  }
  const path = join(dirname(run.transcriptPath), 'stage-config.json');
  writeFileSync(path, JSON.stringify(run.stageConfig));
  const mcp = join(dirname(run.transcriptPath), 'runtime-mcp.json');
  writeFileSync(
    mcp,
    JSON.stringify({ mcpServers: { stage: { command: process.execPath, args: [join(root, 'src/stage-mcp.ts'), path] } } }),
  );
  return runClaude({
    ...run,
    model: target.model,
    cwd: dirname(run.transcriptPath),
    tools: [''],
    allowedTools: ['mcp__stage'],
    addDirs: [],
    mcpConfigPath: mcp,
  });
}
