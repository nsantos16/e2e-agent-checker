import { Effect, Exit, Cause } from 'effect';
import { runEffect } from './runtime/effect.ts';
import { CheckerLive } from './runtime/services.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { exploreEffect, newRunDir } from './explore.ts';
import { verifyEffect } from './verify.ts';
import { baseUrl, getSlot } from './slots.ts';

// Runs several Qase cases across a pool of slots, one agent per slot at a time.

const { values } = parseArgs({
  options: {
    cases: { type: 'string' },
    slots: { type: 'string', default: '1' },
    project: { type: 'string', default: 'DEMO' },
    model: { type: 'string', default: 'sonnet' },
    repeat: { type: 'string', default: '1' },
    label: { type: 'string', default: '' },
    pipeline: { type: 'string', default: 'explore' },
    'reuse-batch': { type: 'string' },
  },
});

// With --pipeline verify, --reuse-batch <summary.json> reuses each case's earlier explore run instead of exploring again.
const reuse = new Map<number, string>(
  values['reuse-batch'] && existsSync(values['reuse-batch'])
    ? (JSON.parse(readFileSync(values['reuse-batch'], 'utf8')) as { caseId: number; runDir: string; verdict: string }[])
        .filter((r) => r.verdict !== 'error')
        .map((r) => [r.caseId, r.runDir])
    : [],
);

const caseIds = values.cases!.split(',').map(Number);
const queue = Array.from({ length: Number(values.repeat) }, () => caseIds).flat();
const slots = values.slots!.split(',');
const results: Record<string, unknown>[] = [];

const worker = (slot: string) =>
  Effect.gen(function* () {
    const s = getSlot(slot);
    if (!s) throw new Error(`Slot ${slot} is not running. Start it with: node src/slots.ts start --slot ${slot} --worktree <path>`);
    for (let caseId = queue.shift(); caseId !== undefined; caseId = queue.shift()) {
      console.log(`[slot ${slot}] start ${values.project}-${caseId}`);
      if (values.pipeline === 'verify') {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const summary = yield* verifyEffect({
              project: values.project!,
              caseId,
              slot,
              model: values.model!,
              fromRun: reuse.get(caseId),
            });
            const replays = (summary.replays as { status: string; failedStep?: string; mp4Bytes?: number }[] | undefined) ?? [];
            const codifyInfo = summary.codify as { outcome?: string; attempts?: number; metrics?: { costUsd: number } } | undefined;
            results.push({
              caseId,
              slot,
              runDir: summary.runDir,
              verdict: summary.outcome,
              explore: (summary.explore as { verdict: string }).verdict,
              codify: codifyInfo?.outcome,
              attempts: codifyInfo?.attempts,
              codifyCost: codifyInfo?.metrics?.costUsd,
              replay: replays[0]?.status,
              failedStep: replays[0]?.failedStep,
              mp4MB: replays[0]?.mp4Bytes ? +(replays[0].mp4Bytes / 1e6).toFixed(2) : undefined,
            });
            console.log(
              `[slot ${slot}] ${values.project}-${caseId}: ${summary.outcome} (codify ${codifyInfo?.outcome}, replay ${replays[0]?.status ?? '-'})`,
            );
          }),
        );
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          results.push({ caseId, slot, verdict: 'error', error: String(error) });
          console.log(`[slot ${slot}] ${values.project}-${caseId}: error ${error}`);
        }
        continue;
      }
      const runDir = newRunDir(values.project!, caseId, slot, values.label);
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const { report, metrics } = yield* exploreEffect({
            project: values.project!,
            caseId,
            base: baseUrl(s),
            role: s.role,
            slot,
            model: values.model!,
            runDir,
          });
          results.push({
            caseId,
            slot,
            runDir,
            verdict: report?.verdict ?? 'unparsed',
            steps: report?.steps.map((st) => `${st.position}:${st.verdict}${st.inferred ? '*' : ''}`).join(' '),
            ...metrics,
            usage: undefined,
          });
          console.log(
            `[slot ${slot}] ${values.project}-${caseId}: ${report?.verdict} · $${metrics.costUsd?.toFixed(3) ?? 'unavailable'} · ${metrics.turns} turns · ${(metrics.wallMs / 1000).toFixed(0)}s`,
          );
        }),
      );
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        results.push({ caseId, slot, runDir, verdict: 'error', error: String(error) });
        console.log(`[slot ${slot}] ${values.project}-${caseId}: error ${error}`);
      }
    }
  });

await runEffect(Effect.forEach(slots, worker, { concurrency: slots.length }).pipe(Effect.provide(CheckerLive)));
const summaryPath = join(
  new URL('..', import.meta.url).pathname,
  'runs',
  `batch-${Date.now()}${values.label ? `-${values.label}` : ''}.json`,
);
writeFileSync(summaryPath, JSON.stringify(results, null, 2));
console.log(`\nSummary: ${summaryPath}`);
console.table(
  values.pipeline === 'verify'
    ? results.map((r) => ({
        case: r.caseId,
        slot: r.slot,
        explore: r.explore,
        codify: r.codify,
        attempts: r.attempts,
        codifyCost: (r.codifyCost as number)?.toFixed(3),
        replay: r.replay,
        failedStep: (r.failedStep as string)?.slice(0, 40),
        mp4MB: r.mp4MB,
        outcome: r.verdict,
      }))
    : results.map((r) => ({
        case: r.caseId,
        slot: r.slot,
        verdict: r.verdict,
        steps: r.steps,
        cost: (r.costUsd as number)?.toFixed(3),
        turns: r.turns,
        secs: Math.round(((r.wallMs as number) ?? 0) / 1000),
      })),
);
