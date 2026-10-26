import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from './jobs.ts';
import { readJson } from './network.ts';
import { readNetwork } from './observations.ts';

export const terminal = (job: { status: string }) => !['queued', 'running', 'cancelling'].includes(job.status);
export const clip = (value: string | undefined, length = 500) => (value && value.length > length ? value.slice(0, length) + '…' : value);
export const viewerUrl = (base: string, id: string) => `${base}/?job=${encodeURIComponent(id)}`;
export function jobSummary(job: Job, base: string) {
  const network = job.runDir ? readNetwork(job.runDir, { errorsOnly: true, limit: 3 }) : undefined;
  const result = {
    id: job.id,
    project: job.project,
    caseId: job.caseId,
    caseRevision: job.caseSnapshot?.revision,
    environment: job.environment,
    status: job.status,
    stage: job.stage,
    outcome: job.outcome,
    terminal: terminal(job),
    target: job.target,
    batchId: job.batchId,
    createdAt: job.createdAt,
    timing: job.timing,
    usage: job.usage,
    error: job.error ? { code: job.errorCode ?? 'RUN_FAILED', message: clip(job.error) } : undefined,
    replay: job.replay
      ? {
          status: job.replay.status,
          failedStep: clip(job.replay.failedStep),
          error: clip(job.replay.error),
          provenance: job.replay.provenance,
          avoidedExecutionMs: job.replay.avoidedExecutionMs,
        }
      : undefined,
    network: network
      ? {
          captured: network.capturedStages.length > 0,
          total: network.total,
          errors: network.errorCount,
          dropped: network.dropped,
          failures: network.requests.map(({ id, method, url, status, requestId, traceId, failure }) => ({
            id,
            method,
            url: clip(url, 240),
            status,
            requestId: clip(requestId, 120),
            traceId: clip(traceId, 120),
            failure: clip(failure, 200),
          })),
        }
      : undefined,
    canReplay: !!job.runDir && existsSync(join(job.runDir, 'codify', `${job.project}-${job.caseId}.spec.ts`)),
    viewerUrl: viewerUrl(base, job.id),
    next: !terminal(job) ? 'wait_jobs' : job.status !== 'done' || job.outcome !== 'pass' ? 'get_evidence' : 'complete',
  };
  return {
    ...result,
    revision: createHash('sha256')
      .update(JSON.stringify([result, job.log.at(-1)]))
      .digest('hex')
      .slice(0, 16),
  };
}

export type ArtifactId = 'case' | 'report' | 'spec' | 'comment' | 'video' | 'trace' | 'usage' | 'pricing' | 'attempt' | 'results';
export function artifactPath(job: Job, id: ArtifactId): string | undefined {
  if (!job.runDir || !existsSync(job.runDir)) return;
  const candidates = {
    usage: join(job.runDir, 'usage.json'),
    pricing: join(job.runDir, 'pricing.json'),
    case: join(job.runDir, 'explore/case.json'),
    report: join(job.runDir, 'explore/report.json'),
    spec: join(job.runDir, 'codify', `${job.project}-${job.caseId}.spec.ts`),
    comment: join(job.runDir, 'pr-comment.md'),
    video: job.video,
    trace: job.replay?.trace as string | undefined,
    attempt: job.replay?.provenance?.manifestPath as string | undefined,
    results: job.replay?.results as string | undefined,
  };
  const path = candidates[id];
  // Accept only this job's artifacts, including after symlink resolution.
  if (!path || !existsSync(path)) return;
  const canonical = realpathSync(path);
  return canonical.startsWith(realpathSync(job.runDir) + '/') && statSync(canonical).isFile() ? canonical : undefined;
}
export function readEvidence(job: Job, base: string, options: { artifact?: string; offset?: number; limit?: number } = {}) {
  const ids: ArtifactId[] = ['case', 'report', 'spec', 'comment', 'video', 'trace', 'usage', 'pricing', 'attempt', 'results'];
  const artifacts = ids.flatMap((id) => {
    const path = artifactPath(job, id);
    return path
      ? [
          {
            id,
            bytes: statSync(path).size,
            url: `${base}/api/jobs/${encodeURIComponent(job.id)}/artifacts/${id}`,
          },
        ]
      : [];
  });
  if (!options.artifact) {
    const reportPath = artifactPath(job, 'report');
    const report = reportPath ? readJson<{ verdict?: string; steps?: any[] }>(reportPath) : undefined;
    const failedSteps = (job.steps ?? report?.steps ?? []).filter((s) => s.verdict !== 'pass');
    return {
      jobId: job.id,
      verdict: job.outcome ?? job.exploreVerdict ?? report?.verdict ?? null,
      // Keep a completed failure distinct from an infrastructure failure; report is available in full on demand.
      failedStepCount: failedSteps.length,
      failedSteps: failedSteps.slice(0, 10).map((s) => ({
        position: s.position,
        verdict: s.verdict,
        evidence: clip(typeof s.evidence === 'string' ? s.evidence : JSON.stringify(s.evidence)),
      })),
      artifacts,
      provenance: job.replay?.provenance,
      avoidedExecutionMs: job.replay?.avoidedExecutionMs,
      availableText: ['logs', ...artifacts.filter((a) => !['video', 'trace'].includes(a.id)).map((a) => a.id)],
    };
  }
  const id = options.artifact;
  if (!['logs', 'case', 'report', 'spec', 'comment', 'usage', 'pricing', 'attempt', 'results'].includes(id))
    throw Object.assign(new Error('Use an artifact URL to read binary evidence'), { code: 'INVALID_INPUT' });
  const path = id === 'logs' ? undefined : artifactPath(job, id as ArtifactId);
  if (id !== 'logs' && !path)
    throw Object.assign(new Error('Artifact has not been captured'), {
      code: 'ARTIFACT_MISSING',
    });
  const text = id === 'logs' ? job.log.join('\n') : readFileSync(path!, 'utf8');
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(16000, Math.floor(options.limit ?? 4000)));
  return {
    jobId: job.id,
    artifact: id,
    offset,
    totalChars: text.length,
    text: text.slice(offset, offset + limit),
    nextOffset: offset + limit < text.length ? offset + limit : null,
  };
}
