import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { codify, specLocation, type CodifyResult } from './codify.ts';
import { explore, newRunDir, type ExploreReport } from './explore.ts';
import { replay } from './replay.ts';
import { baseUrl, getSlot } from './slots.ts';

// Explore → Codify → Replay → Package for one Qase case (docs/architecture-proposals.md, proposal C).

export type VerifyOptions = {
  project: string;
  caseId: number;
  slot: string;
  replaySlots?: string[];
  model: string;
  fromRun?: string;
  replayOnly?: boolean;
  log?: (l: string) => void;
};

const root = new URL('..', import.meta.url).pathname;

export const verify = async (opts: VerifyOptions) => {
  const slot = getSlot(opts.slot);
  if (!slot) throw new Error(`Slot ${opts.slot} is not running`);
  const runDir = opts.fromRun ?? newRunDir(opts.project, opts.caseId, opts.slot, 'verify');
  const log = (l: string) => opts.log?.(l);

  let report: ExploreReport | undefined;
  let exploreMetrics: Record<string, unknown> | undefined;
  if (opts.fromRun && existsSync(join(runDir, 'explore/report.json'))) {
    report = JSON.parse(readFileSync(join(runDir, 'explore/report.json'), 'utf8'));
    exploreMetrics = JSON.parse(readFileSync(join(runDir, 'explore/metrics.json'), 'utf8'));
    log(`explore: reusing ${relative(root, runDir)} (${report?.verdict})`);
  } else {
    log('explore: start');
    const explored = await explore({ project: opts.project, caseId: opts.caseId, base: baseUrl(slot), role: slot.role, slot: opts.slot, model: opts.model, runDir, log: (l) => log(`  explore ${l}`) });
    report = explored.report;
    exploreMetrics = explored.metrics;
    log(`explore: ${report?.verdict} ($${explored.metrics.costUsd.toFixed(3)}, ${explored.metrics.turns} turns)`);
  }

  const summary: Record<string, unknown> = { project: opts.project, caseId: opts.caseId, runDir, slot: opts.slot, explore: { verdict: report?.verdict, metrics: exploreMetrics } };
  if (!report || report.verdict === 'blocked') {
    summary.outcome = 'blocked';
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  }

  const previous = join(runDir, 'codify/result.json');
  const codified =
    opts.replayOnly && existsSync(previous)
      ? { result: JSON.parse(readFileSync(previous, 'utf8')) as CodifyResult, metrics: JSON.parse(readFileSync(join(runDir, 'codify/metrics.json'), 'utf8')), ...specLocation(runDir, opts.project, opts.caseId) }
      : (log('codify: start'), await codify({ project: opts.project, caseId: opts.caseId, runDir, base: baseUrl(slot), slot: opts.slot, role: slot.role, model: opts.model, log: (l) => log(`  codify ${l}`) }));
  summary.codify = { ...codified.result, metrics: codified.metrics };
  log(`codify: ${codified.result?.outcome} after ${codified.result?.attempts} attempts ($${codified.metrics.costUsd.toFixed(3)})`);
  if (!codified.result || codified.result.outcome === 'could-not-stabilize') {
    summary.outcome = 'codify-failed';
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  }

  const replays: Record<string, unknown>[] = [];
  for (const replaySlot of [opts.slot, ...(opts.replaySlots ?? [])]) {
    const s = getSlot(replaySlot);
    if (!s) throw new Error(`Replay slot ${replaySlot} is not running`);
    log(`replay: slot ${replaySlot} (${s.worktree})`);
    const r = await replay({ runDir, label: `slot${replaySlot}`, specDir: codified.specDir, specFile: codified.specFile, base: baseUrl(s), slot: replaySlot, role: s.role });
    replays.push({ slot: replaySlot, worktree: s.worktree, ...r, log: undefined });
    log(`replay: slot ${replaySlot} → ${r.status}${r.failedStep ? ` at "${r.failedStep}"` : ''} · ${r.mp4Bytes ? `${(r.mp4Bytes / 1e6).toFixed(1)} MB mp4` : 'no video'}`);
  }
  summary.replays = replays;
  summary.spec = codified.specPath;
  summary.outcome = (replays[0] as { status: string }).status === 'passed' ? 'pass' : 'fail';
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(runDir, 'pr-comment.md'), prComment(summary, report));
  return summary;
};

export const prComment = (summary: Record<string, unknown>, report: ExploreReport) => {
  const icon = (v: string) => ({ pass: '✅', fail: '❌', blocked: '⛔' })[v] ?? '❔';
  const replays = (summary.replays as { slot: string; status: string; failedStep?: string; video?: string }[]) ?? [];
  const lines = [
    `### ${icon(String(summary.outcome))} ${summary.project}-${summary.caseId} (agent verification)`,
    '',
    '| Step | Result | Evidence |',
    '|---|---|---|',
    ...report.steps.map((s) => `| ${s.position} | ${icon(s.verdict)}${s.inferred ? ' (inferred)' : ''} | ${s.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220)} |`),
    '',
    `Deterministic replay of the generated spec: ${replays.map((r) => `slot ${r.slot} **${r.status}**${r.failedStep ? ` (${r.failedStep})` : ''}`).join(', ')}`,
    '',
    ...replays.filter((r) => r.video).map((r) => r.video!),
  ];
  if (report.notes) lines.splice(5 + report.steps.length, 0, '', `> ${report.notes.replace(/\n/g, ' ').slice(0, 600)}`);
  return lines.join('\n') + '\n';
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      case: { type: 'string' },
      project: { type: 'string', default: 'DEMO' },
      slot: { type: 'string', default: '1' },
      'replay-slots': { type: 'string', default: '' },
      model: { type: 'string', default: 'sonnet' },
      'from-run': { type: 'string' },
      'replay-only': { type: 'boolean', default: false },
    },
  });
  const summary = await verify({
    project: values.project!,
    caseId: Number(values.case),
    slot: values.slot!,
    replaySlots: values['replay-slots'] ? values['replay-slots'].split(',') : [],
    model: values.model!,
    fromRun: values['from-run'] ? join(root, values['from-run'].replace(/^.*runs\//, 'runs/')) : undefined,
    replayOnly: values['replay-only'],
    log: (l) => console.log(l),
  });
  console.log(`\nOutcome: ${summary.outcome} · ${summary.runDir}`);
}
