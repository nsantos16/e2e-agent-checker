import type { TestCase } from './cases.ts';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { codify, specLocation } from './codify.ts';
import { explore, newRunDir, type ExploreReport } from './explore.ts';
import { replay } from './replay.ts';
import { baseUrl, getSlot } from './slots.ts';
import { targetSchema, type Target } from './providers/index.ts';
import type { RunMetrics } from './usage.ts';
export type VerifyOptions = {
  project: string;
  caseId: number;
  caseSnapshot?: TestCase;
  slot: string;
  role?: string;
  replaySlots?: string[];
  model: string;
  target?: Target;
  signal?: AbortSignal;
  maxAttempts?: number;
  fromRun?: string;
  replayOnly?: boolean;
  runDir?: string;
  onStage?: (stage: string) => void;
  onMetrics?: (stage: string, metrics: RunMetrics) => void;
  log?: (line: string) => void;
};
const root = new URL('..', import.meta.url).pathname;
export const verify = async (opts: VerifyOptions) => {
  const slot = getSlot(opts.slot);
  if (!slot) throw new Error(`Slot ${opts.slot} is not running`);
  const runDir = opts.runDir ?? newRunDir(opts.project, opts.caseId, opts.slot, opts.replayOnly ? 'replay' : 'verify');
  const log = (s: string) => opts.log?.(s);
  const stage = (s: string) => {
    opts.signal?.throwIfAborted();
    opts.onStage?.(s);
    log(`${s}: start`);
  };
  const summary: Record<string, any> = { project: opts.project, caseId: opts.caseId, slot: opts.slot, runDir, target: opts.target };
  const save = () => writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  let report: ExploreReport;
  let spec = specLocation(runDir, opts.project, opts.caseId);
  if (opts.replayOnly) {
    if (!opts.fromRun) throw new Error('ARTIFACT_MISSING: replay requires an existing run');
    const old = specLocation(opts.fromRun, opts.project, opts.caseId);
    const saved = join(opts.fromRun, 'codify', old.specFile);
    const reportPath = join(opts.fromRun, 'explore/report.json');
    if (!existsSync(saved) || !existsSync(reportPath)) throw new Error('ARTIFACT_MISSING: saved spec or report is missing');
    mkdirSync(spec.specDir, { recursive: true });
    mkdirSync(join(runDir, 'explore'), { recursive: true });
    mkdirSync(join(runDir, 'codify'), { recursive: true });
    copyFileSync(saved, spec.specPath);
    copyFileSync(saved, join(runDir, 'codify', spec.specFile));
    copyFileSync(reportPath, join(runDir, 'explore/report.json'));
    const oldCase = join(opts.fromRun, 'explore/case.json');
    if (existsSync(oldCase)) copyFileSync(oldCase, join(runDir, 'explore/case.json'));
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
    summary.reusedFrom = opts.fromRun;
    summary.explore = { verdict: report.verdict, reused: true };
    summary.codify = { reused: true };
  } else {
    stage('explore');
    const explored = await explore({
      project: opts.project,
      caseId: opts.caseId,
      caseSnapshot: opts.caseSnapshot,
      base: baseUrl(slot),
      role: opts.role ?? slot.role,
      slot: opts.slot,
      model: opts.model,
      runDir,
      target: opts.target,
      signal: opts.signal,
      onMetrics: (m) => opts.onMetrics?.('explore', m),
      log,
    });
    report = explored.report;
    summary.explore = { verdict: report.verdict, metrics: explored.metrics };
    save();
    if (report.verdict === 'blocked') {
      summary.outcome = 'blocked';
      save();
      return summary;
    }
    stage('codify');
    const codified = await codify({
      project: opts.project,
      caseId: opts.caseId,
      base: baseUrl(slot),
      role: opts.role ?? slot.role,
      slot: opts.slot,
      model: opts.model,
      runDir,
      target: opts.target,
      signal: opts.signal,
      maxAttempts: opts.maxAttempts,
      onMetrics: (m) => opts.onMetrics?.('codify', m),
      log,
    });
    summary.codify = { ...codified.result, metrics: codified.metrics };
    save();
    if (codified.result.outcome === 'could-not-stabilize') {
      summary.outcome = 'codify-failed';
      save();
      return summary;
    }
    spec = codified;
  }
  summary.replays = [];
  for (const replaySlot of [opts.slot, ...(opts.replaySlots ?? [])]) {
    const s = getSlot(replaySlot);
    if (!s) throw new Error(`Replay slot ${replaySlot} is not running`);
    stage('replay');
    const r = await replay({
      runDir,
      label: `slot${replaySlot}`,
      specDir: spec.specDir,
      specFile: spec.specFile,
      base: baseUrl(s),
      slot: replaySlot,
      role: opts.role ?? s.role,
      signal: opts.signal,
      onPackage: () => stage('package'),
    });
    summary.replays.push({ slot: replaySlot, worktree: s.worktree, ...r, log: undefined });
    save();
  }
  summary.spec = spec.specPath;
  summary.outcome = summary.replays[0].status === 'passed' ? 'pass' : summary.replays[0].status === 'failed' ? 'fail' : 'blocked';
  save();
  writeFileSync(join(runDir, 'pr-comment.md'), prComment(summary, report));
  return summary;
};

export const prComment = (summary: Record<string, unknown>, report: ExploreReport) => {
  const icon = (v: string) => ({ pass: '✅', fail: '❌', blocked: '⛔' })[v] ?? '❔';
  const replays = (summary.replays as { slot: string; status: string; failedStep?: string; video?: string }[]) ?? [];
  const lines = [
    `### ${icon(String(summary.outcome))} ${summary.project}-${summary.caseId} (verification)`,
    '',
    '| Step | Result | Evidence |',
    '|---|---|---|',
    ...report.steps.map(
      (s) =>
        `| ${s.position} | ${icon(s.verdict)}${s.inferred ? ' (inferred)' : ''} | ${s.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220)} |`,
    ),
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
      provider: { type: 'string', default: 'claude-code' },
      'timeout-ms': { type: 'string', default: '1200000' },
      'max-attempts': { type: 'string', default: '8' },
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
    target: targetSchema.parse({ provider: values.provider, model: values.model, authMode: 'subscription' }),
    signal: AbortSignal.timeout(Number(values['timeout-ms'])),
    maxAttempts: Number(values['max-attempts']),
    fromRun: values['from-run'] ? join(root, values['from-run'].replace(/^.*runs\//, 'runs/')) : undefined,
    replayOnly: values['replay-only'],
    log: (l) => console.log(l),
  });
  console.log(`\nOutcome: ${summary.outcome} · ${summary.runDir}`);
}
