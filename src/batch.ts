import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { explore, newRunDir } from './explore.ts';
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
  },
});

const caseIds = values.cases!.split(',').map(Number);
const queue = Array.from({ length: Number(values.repeat) }, () => caseIds).flat();
const slots = values.slots!.split(',');
const results: Record<string, unknown>[] = [];

const worker = async (slot: string) => {
  const s = getSlot(slot);
  if (!s) throw new Error(`Slot ${slot} is not running. Start it with: node src/slots.ts start --slot ${slot} --worktree <path>`);
  for (let caseId = queue.shift(); caseId !== undefined; caseId = queue.shift()) {
    const runDir = newRunDir(values.project!, caseId, slot, values.label);
    console.log(`[slot ${slot}] start ${values.project}-${caseId}`);
    try {
      const { report, metrics } = await explore({ project: values.project!, caseId, base: baseUrl(s), role: s.role, slot, model: values.model!, runDir });
      results.push({ caseId, slot, runDir, verdict: report?.verdict ?? 'unparsed', steps: report?.steps.map((st) => `${st.position}:${st.verdict}${st.inferred ? '*' : ''}`).join(' '), ...metrics, usage: undefined });
      console.log(`[slot ${slot}] ${values.project}-${caseId}: ${report?.verdict} · $${metrics.costUsd.toFixed(3)} · ${metrics.turns} turns · ${(metrics.wallMs / 1000).toFixed(0)}s`);
    } catch (error) {
      results.push({ caseId, slot, runDir, verdict: 'error', error: String(error) });
      console.log(`[slot ${slot}] ${values.project}-${caseId}: error ${error}`);
    }
  }
};

await Promise.all(slots.map(worker));
const summaryPath = join(new URL('..', import.meta.url).pathname, 'runs', `batch-${Date.now()}${values.label ? `-${values.label}` : ''}.json`);
writeFileSync(summaryPath, JSON.stringify(results, null, 2));
console.log(`\nSummary: ${summaryPath}`);
console.table(results.map((r) => ({ case: r.caseId, slot: r.slot, verdict: r.verdict, steps: r.steps, cost: (r.costUsd as number)?.toFixed(3), turns: r.turns, secs: Math.round(((r.wallMs as number) ?? 0) / 1000) })));
