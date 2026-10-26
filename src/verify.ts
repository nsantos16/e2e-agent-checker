import { Effect } from 'effect';
import { runEffect } from './runtime/effect.ts';
import { CheckerLive } from './runtime/services.ts';
import { createRunPricingEffect } from './pricing.ts';
import { assertRunnable, type TestCase } from './cases.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { codifyEffect, specLocation } from './codify.ts';
import { exploreEffect, newRunDir, type ExploreReport } from './explore.ts';
import { replayEffect } from './replay.ts';
import { baseUrl, getSlot } from './slots.ts';
import { targetSchema, type Target } from './providers/index.ts';
import type { VerifiedAttempt } from './attempt-evidence.ts';
import { statePath } from './login.ts';
import { noModelUsage, type RunMetrics } from './usage.ts';
import { getEnvironment, getTestUser, type Environment } from './environments.ts';
import { CaseRepository } from './runtime/repositories.ts';
import {
  captureBuild,
  compatibilityContext,
  explorationReportPath,
  publishSavedSpec,
  selectSavedSpec,
  specRequirements,
  type BuildProvenance,
  type SpecSelection,
} from './saved-specs.ts';
export type VerifyOptions = {
  project: string;
  caseId: number;
  caseSnapshot?: TestCase;
  environment?: Environment;
  worktree?: string;
  buildId?: string;
  forceFresh?: boolean;
  slot: string;
  role?: string;
  base?: string;
  storageState?: string;
  environmentId?: string;
  environmentRevision?: string;
  userIdentity?: string;
  replaySlots?: string[];
  model: string;
  target?: Target;
  signal?: AbortSignal;
  maxAttempts?: number;
  fromRun?: string;
  replayOnly?: boolean;
  confirmationReplay?: boolean;
  runDir?: string;
  onStage?: (stage: string) => void;
  onMetrics?: (stage: string, metrics: RunMetrics) => void;
  onSelection?: (selection: SpecSelection, testedBuild: BuildProvenance) => void;
  log?: (line: string) => void;
};
const root = new URL('..', import.meta.url).pathname;
export const verifyEffect = (opts: VerifyOptions) =>
  Effect.gen(function* () {
    const slot = getSlot(opts.slot);
    if (!slot && !opts.base) throw new Error(`Slot ${opts.slot} is not running`);
    const base = opts.base ?? baseUrl(slot!);
    const role = opts.role ?? slot?.role ?? 'eugene';
    const runDir = opts.runDir ?? newRunDir(opts.project, opts.caseId, opts.slot, opts.replayOnly ? 'replay' : 'verify');
    mkdirSync(runDir, { recursive: true });
    if (existsSync(join(runDir, 'summary.json'))) throw new Error('RUN_DIR_EXISTS: verification requires a new run directory');
    if (opts.replayOnly && opts.forceFresh) throw new Error('INVALID_INPUT: forceFresh cannot be combined with replayOnly');
    const worktree = opts.worktree ?? slot?.worktree;
    const testedBuild = captureBuild(base, worktree, opts.buildId);
    const log = (s: string) => opts.log?.(s);
    const stage = (s: string) => {
      opts.signal?.throwIfAborted();
      opts.onStage?.(s);
      log(`${s}: start`);
    };
    const summary: Record<string, any> = {
      project: opts.project,
      caseId: opts.caseId,
      slot: opts.slot,
      runDir,
      target: opts.target,
      testedBuild,
    };
    const save = () => writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    let report: ExploreReport;
    let spec = specLocation(runDir, opts.project, opts.caseId);
    let verifiedAttempt: VerifiedAttempt | undefined;
    const testCase = opts.replayOnly
      ? opts.caseSnapshot
      : (opts.caseSnapshot ?? (yield* (yield* CaseRepository).get(opts.project, opts.caseId)));
    if (testCase && !opts.replayOnly) {
      assertRunnable(testCase);
      if (testCase.project !== opts.project || testCase.id !== opts.caseId)
        throw new Error('INVALID_INPUT: case snapshot identity mismatch');
    }
    const environment = opts.replayOnly ? undefined : (opts.environment ?? getEnvironment(slot?.environmentId));
    const context =
      environment && testCase
        ? compatibilityContext(testCase, specRequirements(environment, getTestUser(environment, role), base, worktree))
        : undefined;
    const selected = context ? selectSavedSpec(context, { forceFresh: opts.forceFresh, runDir }) : undefined;
    const selection: SpecSelection = opts.replayOnly
      ? { mode: 'replay', reason: 'explicit-replay', sourceRun: opts.fromRun }
      : selected!.decision;
    summary.specSelection = selection;
    if (selection.mode !== 'author') {
      summary.usage = noModelUsage(selection.mode === 'reuse' ? 'saved-spec' : 'replay');
      writeFileSync(join(runDir, 'usage.json'), JSON.stringify({ usage: summary.usage, stages: {} }, null, 2));
    }
    save();
    opts.onSelection?.(selection, testedBuild);
    log(`saved spec: ${selection.mode} (${selection.reason})`);
    const useSaved = (sourceRun: string, source: Buffer, historical: ExploreReport, caseBytes?: Buffer) => {
      const originalSource = (historical as ExploreReport & { provenance?: { sourceRun?: string } }).provenance?.sourceRun ?? sourceRun;
      mkdirSync(spec.specDir, { recursive: true });
      mkdirSync(join(runDir, 'historical'), { recursive: true });
      mkdirSync(join(runDir, 'codify'), { recursive: true });
      writeFileSync(spec.specPath, source);
      writeFileSync(join(runDir, 'codify', spec.specFile), source);
      writeFileSync(
        join(runDir, 'historical/explore-report.json'),
        JSON.stringify(
          {
            ...historical,
            provenance: { historical: true, sourceRun: originalSource },
          },
          null,
          2,
        ),
      );
      if (caseBytes) {
        mkdirSync(join(runDir, 'explore'), { recursive: true });
        writeFileSync(join(runDir, 'explore/case.json'), caseBytes);
      }
      summary.reusedFrom = sourceRun;
      summary.explore = { verdict: historical.verdict, reused: true, historical: true, sourceRun: originalSource };
      summary.historicalExploration = { sourceRun: originalSource, verdict: historical.verdict };
      summary.codify = { reused: true };
      save();
    };
    if (opts.replayOnly) {
      if (!opts.fromRun) throw new Error('ARTIFACT_MISSING: replay requires an existing run');
      const old = specLocation(opts.fromRun, opts.project, opts.caseId);
      const saved = join(opts.fromRun, 'codify', old.specFile);
      const reportPath = explorationReportPath(opts.fromRun);
      if (!existsSync(saved) || !existsSync(reportPath)) throw new Error('ARTIFACT_MISSING: saved spec or report is missing');
      const oldCase = join(opts.fromRun, 'explore/case.json');
      report = JSON.parse(readFileSync(reportPath, 'utf8'));
      useSaved(opts.fromRun, readFileSync(saved), report, existsSync(oldCase) ? readFileSync(oldCase) : undefined);
    } else if (selected?.saved) {
      const saved = selected.saved;
      report = saved.report;
      summary.authoredBuild = saved.manifest.testedBuild;
      useSaved(saved.runDir, saved.spec, report, saved.caseBytes);
      writeFileSync(join(runDir, 'historical/manifest.json'), JSON.stringify(saved.manifest, null, 2));
    } else {
      const pricing = yield* createRunPricingEffect(runDir);
      stage('explore');
      const explored = yield* exploreEffect({
        project: opts.project,
        caseId: opts.caseId,
        caseSnapshot: testCase,
        base,
        storageState: opts.storageState,
        role,
        slot: opts.slot,
        model: opts.model,
        runDir,
        target: opts.target,
        pricing,
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
      const codified = yield* codifyEffect({
        project: opts.project,
        caseId: opts.caseId,
        base,
        storageState: opts.storageState,
        environmentId: opts.environmentId,
        environmentRevision: opts.environmentRevision,
        userIdentity: opts.userIdentity,
        role,
        slot: opts.slot,
        model: opts.model,
        runDir,
        target: opts.target,
        pricing,
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
      verifiedAttempt = codified.verifiedAttempt;
    }
    summary.replays = [];
    for (const [index, replaySlot] of [opts.slot, ...(opts.replaySlots ?? [])].entries()) {
      const s = getSlot(replaySlot);
      if (!s && !(replaySlot === opts.slot && opts.base)) throw new Error(`Replay slot ${replaySlot} is not running`);
      stage('evidence');
      const r = yield* replayEffect({
        runDir,
        label: `slot${replaySlot}${index > 0 && [opts.slot, ...(opts.replaySlots ?? [])].slice(0, index).includes(replaySlot) ? `-${index + 1}` : ''}`,
        specDir: spec.specDir,
        specFile: spec.specFile,
        base: replaySlot === opts.slot ? base : baseUrl(s!),
        storageState: replaySlot === opts.slot ? opts.storageState : undefined,
        slot: replaySlot,
        role: opts.role ?? s?.role ?? role,
        signal: opts.signal,
        reuseAttempt: index === 0 && selection.mode === 'author' && !opts.confirmationReplay ? verifiedAttempt : undefined,
        evidenceContext: {
          runDir,
          specPath: spec.specPath,
          casePath: join(runDir, 'explore/case.json'),
          base,
          slot: opts.slot,
          role,
          storageState: opts.storageState ?? statePath(opts.slot, role),
          environmentId: opts.environmentId,
          environmentRevision: opts.environmentRevision,
          userIdentity: opts.userIdentity,
        },
        onReplay: () => stage('replay'),
        onPackage: () => stage('package'),
      });
      summary.replays.push({ slot: replaySlot, worktree: replaySlot === opts.slot ? worktree : s?.worktree, ...r, log: undefined });
      save();
    }
    summary.spec = spec.specPath;
    summary.outcome =
      summary.replays[0].status === 'passed' ? 'pass' : ['failed', 'timedOut'].includes(summary.replays[0].status) ? 'fail' : 'blocked';
    const replay = summary.replays[0];
    const currentReport: ExploreReport = {
      caseId: opts.caseId,
      verdict: summary.outcome,
      steps: (testCase?.steps ?? report.steps).map(({ position }) => {
        const step = replay.steps?.find((s: { title: string }) => s.title.startsWith(`Step ${position}:`));
        return {
          position,
          verdict: !step ? 'blocked' : step.error ? 'fail' : 'pass',
          evidence: !step
            ? 'Step was not recorded in this execution.'
            : step.error
              ? JSON.stringify(step.error)
              : `Execution passed: ${step.title}`,
        };
      }),
    };
    summary.verification = currentReport;
    writeFileSync(join(runDir, 'verification.json'), JSON.stringify({ ...currentReport, source: replay.provenance.kind, testedBuild }, null, 2));
    save();
    writeFileSync(join(runDir, 'pr-comment.md'), prComment(summary, currentReport));
    if (selection.mode === 'author' && context && ['pass', 'fail'].includes(summary.outcome))
      publishSavedSpec(runDir, context, testedBuild);
    return summary;
  });
export const verify = (opts: VerifyOptions) => runEffect(verifyEffect(opts).pipe(Effect.provide(CheckerLive)), opts.signal);

export const prComment = (summary: Record<string, unknown>, report: ExploreReport) => {
  const icon = (v: string) => ({ pass: '✅', fail: '❌', blocked: '⛔' })[v] ?? '❔';
  const replays =
    (summary.replays as {
      slot: string;
      status: string;
      failedStep?: string;
      video?: string;
      provenance?: { kind: string; attemptId?: string };
    }[]) ?? [];
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
    ...(summary.historicalExploration
      ? ['Original exploration is historical; the results and evidence above are from this replay.', '']
      : []),
    ...replays.map(
      (r) =>
        `Slot ${r.slot}: **${r.status}**${r.failedStep ? ` (${r.failedStep})` : ''} — ${
          r.provenance?.kind === 'stabilization'
            ? `verified stabilization attempt ${r.provenance.attemptId} reused as final evidence (no second execution)`
            : 'independent deterministic replay of the generated spec'
        }.`,
    ),
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
      'confirmation-replay': { type: 'boolean', default: false },
      'force-fresh': { type: 'boolean', default: false },
      'build-id': { type: 'string' },
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
    confirmationReplay: values['confirmation-replay'],
    forceFresh: values['force-fresh'],
    buildId: values['build-id'],
    log: (l) => console.log(l),
  });
  console.log(`\nOutcome: ${summary.outcome} · ${summary.runDir}`);
}
