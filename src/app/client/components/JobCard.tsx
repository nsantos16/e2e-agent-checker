import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { fileUrl } from '../api.ts';
import { dollars, duration, modelName, number, outcomeLabel, STAGES, terminal } from '../format.ts';
import type { JobView } from '../types.ts';
import { Icon } from './Icon.tsx';
import { ObservationPanel } from './NetworkInspector.tsx';
export function JobCard({ job: j }: { job: JobView }) {
  const { state: s, actions: store } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const active = j.id === s.activeJob,
    open = s.expanded.has(j.id),
    detail = s.details[j.id];
  const state = j.status === 'done' ? (j.outcome ?? j.status) : j.status;
  const wt = s.worktrees.find((w) => w.path === j.worktree);
  const elapsed = (j.finishedAt ? Date.parse(j.finishedAt) : Date.now()) - Date.parse(j.createdAt);
  const activeMs = j.timing
    ? j.finishedAt
      ? j.timing.activeMs
      : j.startedAt
        ? Date.now() - Date.parse(j.startedAt)
        : j.timing.activeMs
    : null;
  const estimated = j.usage?.estimatedApiCostUsd != null;
  const cost = j.usage?.estimatedApiCostUsd ?? j.usage?.providerReportedCostUsd ?? j.costUsd;
  const index = j.status === 'done' ? STAGES.length : j.status === 'queued' ? -1 : Math.max(0, STAGES.indexOf(j.stage ?? 'prepare'));
  const action = async (action: 'cancel' | 'replay' | 'rerun') => {
    setBusy(true);
    try {
      await store.jobAction(j, action);
    } catch (e) {
      store.report(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="job" data-job={j.id} hidden={!active}>
      <div className="job-summary">
        <div
          className="job-head"
          data-toggle={j.id}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={() => void store.toggleExpanded(j.id).catch(store.report)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void store.toggleExpanded(j.id).catch(store.report);
            }
          }}
        >
          <span className="id">
            {j.project}-{j.caseId}
          </span>
          <span className="title">{j.title ?? `${j.project}-${j.caseId}`}</span>
          <span className={`chip ${state}`}>{outcomeLabel[state] ?? state}</span>
        </div>
        <div className="job-sub">
          <span>{j.environment ? j.environment.name + ' · ' + j.environment.userName : `${j.project}-${j.caseId}`}</span>
          <span>
            {wt?.branch ?? j.worktree.split('/').pop()}
            {j.slot ? ` · slot ${j.slot}` : ''}
          </span>
          <span>{j.target ? `${j.target.provider} / ${modelName(j.target, s.providers)}` : 'Historical run'}</span>
        </div>
        <div className="run-metrics">
          <div className="metric">
            <span>{j.timing ? 'Active time' : 'Elapsed time'}</span>
            <strong>{duration(activeMs ?? elapsed)}</strong>
            <small>{j.timing ? `${duration(j.timing.queueMs)} queued` : 'Includes queue time'}</small>
          </div>
          <div className="metric">
            <span>Tokens</span>
            <strong>{number(j.usage?.totalTokens)}</strong>
            <small>{j.replayOf ? 'Replay only · no model calls' : j.usage ? `${j.usage.status} usage` : 'Not recorded'}</small>
          </div>
          <div className="metric">
            <span>{estimated ? 'API-equivalent cost' : 'Reported cost'}</span>
            <strong>{dollars(cost)}</strong>
            <small>
              {j.replayOf
                ? 'No model calls'
                : estimated
                  ? 'Standard API estimate · not a bill'
                  : j.target?.authMode === 'subscription'
                    ? 'Subscription · billed amount unknown'
                    : 'Provider estimate, when recorded'}
            </small>
          </div>
        </div>
        <div className="metrics">
          {j.usage
            ? `Input ${number(j.usage.inputTokens)} · output ${number(j.usage.outputTokens)} · cache read ${number(j.usage.cacheReadTokens)} · cache write ${number(j.usage.cacheWriteTokens)}`
            : 'Detailed usage was not recorded for this run.'}
        </div>
        {!terminal(j) && (
          <>
            <div className="pipeline">
              {STAGES.map((stage, i) => (
                <div key={stage} className={i < index ? 'done' : i === index ? 'active' : ''}>
                  {stage}
                </div>
              ))}
            </div>
            <div className="log">{j.log?.at(-1) ?? 'Waiting for an available test identity…'}</div>
          </>
        )}
        {!!j.steps?.length && (
          <div className="steps">
            {j.steps.map((step) => (
              <span key={step.position} className={`step ${step.verdict}`} title={step.evidence}>
                {step.position}
                {step.verdict === 'pass' ? ' ✓' : step.verdict === 'fail' ? ' ×' : ' –'}
                {step.inferred ? ' *' : ''}
              </span>
            ))}
          </div>
        )}
        {j.error && <div className="error">{j.error}</div>}
        <div className="job-actions">
          {!terminal(j) ? (
            <button data-cancel={j.id} disabled={busy || j.status === 'cancelling'} onClick={() => void action('cancel')}>
              {j.status === 'cancelling' ? 'Cancelling…' : 'Cancel run'}
            </button>
          ) : j.canReplay ? (
            <button data-replay={j.id} disabled={busy} onClick={() => void action('replay')}>
              <Icon name="replay" />
              Replay saved spec
            </button>
          ) : null}
          {terminal(j) && (
            <button data-rerun={j.id} disabled={busy} onClick={() => void action('rerun')}>
              Run again
            </button>
          )}
        </div>
      </div>
      {(active || open) && <ObservationPanel job={j} active={active} />}
      {open && detail && <RunEvidence job={j} detail={detail} active={active} />}
    </div>
  );
}
function RunEvidence({ job, detail, active }: { job: JobView; detail: JobView; active: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!active) video.current?.pause();
  }, [active]);
  return (
    <div className="detail">
      {detail.video && <video ref={video} src={fileUrl(detail.video)} controls preload="metadata" />}
      <div className="detail-content">
        {job.timing && (
          <div className="metrics">
            {Object.entries(job.timing.stages)
              .map(([stage, ms]) => `${stage} ${duration(ms)}`)
              .join(' · ')}
          </div>
        )}
        <table aria-label="Step evidence">
          <tbody>
            {(detail.steps ?? []).map((step) => (
              <tr key={step.position}>
                <td>
                  <span className={`step ${step.verdict}`}>
                    {step.position} {step.verdict}
                    {step.inferred ? ' *' : ''}
                  </span>
                </td>
                <td>{step.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {detail.notes && <div className="notes">{detail.notes}</div>}
        <div className="links">
          {detail.prComment && (
            <a href={fileUrl(detail.prComment)} target="_blank" rel="noopener">
              PR comment ↗
            </a>
          )}
          {detail.spec && (
            <a href={fileUrl(detail.spec)} target="_blank" rel="noopener">
              Generated spec ↗
            </a>
          )}
          {detail.runDir && <span className="meta">{detail.runDir.split('/').pop()}</span>}
        </div>
        {job.stageMetrics && (
          <div className="metrics">
            {Object.entries(job.stageMetrics).map(([stage, metrics]) => (
              <div key={stage}>
                {stage} · {metrics.toolCalls} tool calls · {metrics.models.join(', ')}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
