import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Job } from './jobs.ts';
import type { RunSession } from './sessions.ts';
import type { BuildProvenance } from './saved-specs.ts';
import { artifactPath, terminal } from './agent-view.ts';
import { demoView } from './demos.ts';
import { digest, stateFile, writeState } from './local-state.ts';
import { scrubText } from './network.ts';

export const summaryFormatVersion = 1;
export const resultOf = (job?: Job) =>
  !job ? 'unavailable' : !terminal(job) ? 'incomplete' : job.status !== 'done' ? job.status : (job.outcome ?? 'incomplete');
const bounded = (v: unknown, max = 600) => scrubText(String(v ?? '')).slice(0, max);
const markdown = (v: unknown) =>
  bounded(v, 1000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()#+.!|~-]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
function runEvidence(id: string, job: Job | undefined, base: string) {
  if (!job)
    return {
      id,
      result: 'unavailable',
      limitations: ['Run record is no longer available; session membership was retained.'],
    };
  const path = artifactPath(job, 'report');
  let report: any;
  try {
    report = path ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  } catch {
    /* damaged evidence remains unavailable */
  }
  const steps = job.steps ?? report?.steps ?? [];
  const currentReport = !!path && basename(path) === 'verification.json';
  const historical = !!job.historicalExploration || job.specSelection?.mode === 'reuse' || !!job.replayOf;
  const build: BuildProvenance | null = job.testedBuild ?? (job.build ? { ...job.build, baseUrl: job.environment?.baseUrl ?? '' } : null);
  const demos = demoView(job, base);
  return {
    id,
    case: `${job.project}-${job.caseId}`,
    title: job.caseSnapshot?.title ?? `${job.project}-${job.caseId}`,
    caseRevision: job.caseSnapshot?.revision,
    result: resultOf(job),
    status: job.status,
    exploreVerdict: historical ? undefined : (job.exploreVerdict ?? (currentReport ? undefined : report?.verdict)),
    historicalExploration: job.historicalExploration ?? null,
    specSelection: job.specSelection ?? null,
    stepEvidence: currentReport ? 'current verification' : path ? 'exploration' : 'saved run record',
    replay: job.replay
      ? {
          status: job.replay.status,
          failedStep: bounded(job.replay.failedStep),
          error: bounded(job.replay.error),
        }
      : null,
    environment: job.environment ?? null,
    worktree: job.worktree || null,
    build,
    target: job.target ?? null,
    replayOf: job.replayOf,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    viewerUrl: `${base}/?job=${encodeURIComponent(id)}`,
    video: artifactPath(job, 'video') ? `${base}/api/jobs/${id}/artifacts/video` : null,
    steps: steps.slice(0, 100).map((s: any) => ({
      position: s.position,
      verdict: s.verdict,
      inferred: !!s.inferred,
      evidence: bounded(s.evidence),
    })),
    error: bounded(job.error),
    notes: bounded(report?.notes),
    demos: demos.map((d) => ({
      id: d.id,
      status: d.status,
      options: d.options,
      progress: d.progress,
      error: d.error,
      artifacts: d.artifacts,
      textUsage: d.textUsage?.usage,
      speechUsage: d.speechUsage,
      textCacheHit: d.textCacheHit,
      speechCacheHits: d.speechCacheHits,
      usageMayBeIncomplete: d.usageMayBeIncomplete,
    })),
    limitations: [
      ...(!build?.commit && !build?.buildId
        ? ['Build commit was not recorded.']
        : build?.dirty
          ? ['Worktree had uncommitted changes; the commit alone does not identify the tested build.']
          : []),
      ...(!path ? ['Detailed verification report unavailable.'] : []),
      ...(job.cacheClearedAt ? ['Run artifacts expired under cache retention; saved run results remain available.'] : []),
      ...(!artifactPath(job, 'video') ? ['Replay video unavailable.'] : []),
      ...(historical ? ['The saved spec came from historical exploration; only the current replay establishes this run’s result.'] : []),
      ...(steps.length > 100 ? ['Step evidence truncated to 100 entries; read the full report for remaining steps.'] : []),
      ...(steps.some((s: any) => s.inferred) ? ['Some recorded checks were inferred rather than directly observed.'] : []),
    ],
  };
}
export function buildSessionSummary(session: RunSession, jobs: (Job | undefined)[], base: string) {
  const runs = session.jobIds.map((id) =>
    runEvidence(
      id,
      jobs.find((j) => j?.id === id),
      base,
    ),
  );
  const counts: Record<string, number> = {};
  for (const run of runs) counts[run.result] = (counts[run.result] ?? 0) + 1;
  const data = {
    formatVersion: summaryFormatVersion,
    session: {
      id: session.id,
      title: session.title,
      revision: session.revision,
      jobIds: session.jobIds,
    },
    counts,
    runs,
    limitations: [
      'Only explicitly recorded session members are covered. No unrun work is claimed as verified.',
      'Exploration verdicts and deterministic replay results are separate evidence.',
      'Artifact and viewer links are local to this checker until explicitly published.',
      'Synthetic narration explains recorded evidence; it is not an additional test.',
    ],
  };
  return {
    ...data,
    revision: digest(data),
    markdown: renderSessionSummary(data),
  };
}
export type SessionSummary = ReturnType<typeof buildSessionSummary>;
export function renderSessionSummary(
  summary: {
    session: Pick<RunSession, 'id' | 'title'>;
    counts: Record<string, number>;
    runs: ReturnType<typeof runEvidence>[];
    limitations: string[];
  },
  publishedVideos?: Record<string, string>,
) {
  const lines = [
    `### Verification session: ${markdown(summary.session.title)}`,
    '',
    `Session: \`${summary.session.id}\` · ${summary.runs.length} run(s) · ${
      Object.entries(summary.counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ') || 'No runs'
    }`,
    '',
    '| Case / run | Result | Exploration | Replay | Environment / build |',
    '|---|---|---|---|---|',
    ...summary.runs.map(
      (r) =>
        `| ${markdown(r.case ?? r.id)} / ${markdown(r.id)} | **${markdown(r.result)}** | ${markdown(r.exploreVerdict ?? (r.historicalExploration || r.specSelection?.mode === 'reuse' || r.replayOf ? 'historical only' : 'unavailable'))} | ${markdown(r.replay?.status ?? 'unavailable')} | ${markdown(r.environment ? `${r.environment.name} / ${r.environment.userName}` : 'unknown')} · ${markdown(r.build?.buildId ?? r.build?.commit ?? 'build unknown')}${r.build?.dirty ? ' (dirty)' : ''} |`,
    ),
    '',
    '#### Evidence and demos',
    '',
  ];
  for (const r of summary.runs) {
    lines.push(`**${markdown(r.case ?? r.id)} — ${markdown(r.title ?? r.id)}**`, '');
    if (r.environment)
      lines.push(
        `Environment: ${markdown(r.environment.name)} (${markdown(r.environment.baseUrl ?? r.worktree)}); configuration revision ${markdown(r.environment.revision)}.`,
        '',
      );
    if (r.target)
      lines.push(
        `Verification: ${markdown(r.target.provider)} / ${markdown(r.target.model)}. Case revision: ${markdown(r.caseRevision ?? 'unknown')}.`,
        '',
      );
    if (r.replayOf) lines.push(`Saved-spec replay of ${markdown(r.replayOf)}.`, '');
    if (r.historicalExploration)
      lines.push(`Historical exploration: ${markdown(r.historicalExploration.verdict)}. It is not a current verification result.`, '');
    if (r.steps?.length)
      lines.push(
        `Step evidence: ${r.stepEvidence}.`,
        '',
        '| Step | Recorded result | Recorded evidence |',
        '|---|---|---|',
        ...r.steps.map(
          (s: any) => `| ${s.position} | ${markdown(s.verdict)}${s.inferred ? ' (inferred)' : ''} | ${markdown(s.evidence)} |`,
        ),
        '',
      );
    if (r.notes) lines.push(`Notes: ${markdown(r.notes)}`, '');
    if (publishedVideos) {
      if (publishedVideos[r.id])
        lines.push(
          `Demo attachment: [${publishedVideos[r.id].includes('narrated') ? 'MP4 with AI-generated voice narration' : 'Silent replay MP4'}](./${publishedVideos[r.id]})`,
          '',
        );
      else lines.push('Video not attached.', '');
    } else {
      if (r.viewerUrl) lines.push(`[Run evidence](${r.viewerUrl})${r.video ? ` · [Silent replay MP4](${r.video})` : ''}`, '');
      for (const d of r.demos ?? [])
        lines.push(
          `Voice narration: **${d.status}** (${markdown(d.options.textModel)}, ${markdown(d.options.speechModel)} / ${markdown(d.options.voice)})${d.artifacts.video ? ` · [MP4 with AI-generated voice](${d.artifacts.video})` : ''}${d.error ? ` — ${markdown(d.error.message)}` : ''}`,
          '',
        );
    }
  }
  lines.push('#### Failures, blocked and incomplete work', '');
  const incomplete = summary.runs.filter(
    (r) => r.result !== 'pass' || (r.exploreVerdict && r.exploreVerdict !== 'pass') || (r.replay && r.replay.status !== 'passed'),
  );
  lines.push(
    ...(incomplete.length
      ? incomplete.map(
          (r) =>
            `- ${markdown(r.case ?? r.id)} / ${markdown(r.id)}: **${markdown(r.result)}**. ${markdown(r.error || r.replay?.error || r.replay?.failedStep || 'Inspect the recorded evidence; this run does not establish a complete pass.')}`,
        )
      : ['No failures recorded among these session members.']),
    '',
    '#### Limitations',
    '',
  );
  lines.push(...summary.limitations.filter((l) => !publishedVideos || !l.startsWith('Artifact and viewer')).map((l) => `- ${l}`));
  for (const r of summary.runs) for (const l of r.limitations) lines.push(`- ${markdown(r.id)}: ${l}`);
  return lines.join('\n') + '\n';
}
export function generateSessionSummary(session: RunSession, jobs: (Job | undefined)[], base: string) {
  const summary = buildSessionSummary(session, jobs, base);
  const file = stateFile(join('session-summaries', session.id + '.json'));
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  if (saved?.revision !== summary.revision) writeState(file, summary);
  return summary;
}
