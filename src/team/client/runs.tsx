import { useSyncExternalStore } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useLiveQuery } from '@tanstack/react-db';
import { useWorkspace } from './context.tsx';
import { runPageScope } from './runs-store.ts';
import type { TeamRun } from '../contracts.ts';
import { duration, outcomeLabel } from '../../app/client/format.ts';

export const runState = (run: TeamRun) =>
  run.status === 'done' ? (run.outcome ?? 'done') : run.status;
export const runLabel = (run: TeamRun) =>
  outcomeLabel[runState(run)] ??
  {
    queued: 'Queued',
    running: 'Running',
    cancelling: 'Cancelling',
    done: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
  }[run.status];
export function RunUser({ run }: { run: TeamRun }) {
  const { actor } = useWorkspace();
  return (
    <span className="team-run-user">
      <span className="team-avatar" aria-hidden="true">
        {run.initiatedBy.name.trim().slice(0, 2).toUpperCase() || '?'}
      </span>
      <span>
        {run.initiatedBy.name}
        {run.initiatedBy.id === actor.userId ? ' (you)' : ''}
      </span>
    </span>
  );
}
export function useRunPage() {
  const { runs } = useWorkspace();
  const search = useSearch({ from: '__root__' });
  const page = useSyncExternalStore(runs.subscribe, runs.getSnapshot);
  const live = useLiveQuery({
    client: runs.db,
    query: (q) => q.from({ run: runs.collection }),
  });
  const current = page.scope === runPageScope(search.userId, search.runAfter);
  const byId = new Map((live.data ?? []).map((run) => [run.id, run]));
  return {
    page: current
      ? page
      : {
          ...page,
          ids: [],
          nextCursor: null,
          stats: null,
          loading: true,
          error: null,
        },
    rows: current
      ? page.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      : [],
  };
}
export function RunsDashboard() {
  const { actor, runs } = useWorkspace();
  const search = useSearch({ from: '__root__' });
  const navigate = useNavigate();
  const { page, rows } = useRunPage();
  const users =
    useLiveQuery({
      client: runs.db,
      query: (q) =>
        q
          .from({ user: runs.userCollection })
          .orderBy(({ user }) => user.name, 'asc'),
    }).data ?? [];
  const filter = (userId?: string) =>
    void navigate({ to: '/', search: { search: '', userId } });
  return (
    <section
      className="team-runs"
      aria-label="Runs dashboard"
      aria-busy={page.loading}
    >
      <header className="team-runs-header">
        <div>
          <div className="eyebrow">{actor.organizationName}</div>
          <h1>Runs</h1>
          <p>Verification activity across your team.</p>
        </div>
        <button
          className="team-action"
          disabled={page.loading}
          onClick={() => void runs.loadPage(search.userId, search.runAfter)}
        >
          Refresh runs
        </button>
      </header>
      <div className="team-run-filters">
        <div className="team-user-filter">
          <label htmlFor="run-user">Started by</label>
          <select
            id="run-user"
            value={search.userId ?? ''}
            onChange={(event) => filter(event.target.value || undefined)}
          >
            <option value="">All users</option>
            {search.userId &&
              !users.some((user) => user.id === search.userId) && (
                <option value={search.userId}>Selected user</option>
              )}
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
                {user.id === actor.userId ? ' (you)' : ''} ·{' '}
                {user.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
        <button
          className="team-action"
          onClick={() =>
            filter(search.userId === actor.userId ? undefined : actor.userId)
          }
        >
          {search.userId === actor.userId ? 'All users' : 'My runs'}
        </button>
        {search.userId && (
          <button className="team-action" onClick={() => filter()}>
            Clear user filter
          </button>
        )}
      </div>
      <dl className="team-run-stats" aria-label="Run totals for selected user">
        {(
          [
            ['total', 'Total runs'],
            ['active', 'In progress'],
            ['passed', 'Passed'],
            ['failed', 'Failed'],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{page.stats?.[key] ?? '—'}</dd>
          </div>
        ))}
      </dl>
      {page.error && (
        <p role="alert" className="team-run-error">
          Could not refresh runs: {page.error}{' '}
          <button
            onClick={() => void runs.loadPage(search.userId, search.runAfter)}
          >
            Retry
          </button>
        </p>
      )}
      <div className="team-runs-caption">
        <h2>Recent runs</h2>
        <span>
          Newest first · {search.userId ? 'Selected user' : 'All users'}
        </span>
      </div>
      <ul className="team-run-list" aria-label="Recent runs">
        {rows.map((run) => (
          <li key={run.id}>
            <div className="team-run-main">
              <Link
                to="/runs/$runId"
                params={{ runId: run.id }}
                search={search}
              >
                {run.title}
              </Link>
              <span className={`chip ${runState(run)}`}>{runLabel(run)}</span>
            </div>
            <div className="team-run-meta">
              <RunUser run={run} />
              <span>{run.caseLabel || run.project}</span>
              {run.model && <span>{run.model}</span>}
              <time dateTime={run.createdAt}>
                {new Date(run.createdAt).toLocaleString()}
              </time>
            </div>
          </li>
        ))}
      </ul>
      {!rows.length && !page.error && (
        <div className="empty team-runs-empty" role="status">
          {page.loading
            ? 'Loading runs…'
            : search.userId
              ? 'No runs from this user yet.'
              : 'No shared runs yet. Published runs from your team will appear here.'}
        </div>
      )}
      <nav className="team-pagination" aria-label="Run pages">
        <span>
          {rows.length} {rows.length === 1 ? 'run' : 'runs'} on this page
        </span>
        {search.runAfter && (
          <Link to="/" search={{ ...search, runAfter: undefined }}>
            First page
          </Link>
        )}
        {page.nextCursor && (
          <Link to="/" search={{ ...search, runAfter: page.nextCursor }}>
            Next page
          </Link>
        )}
      </nav>
    </section>
  );
}

export function RunThread({ run }: { run: TeamRun }) {
  return (
    <article className="job team-run-thread" aria-label="Run thread">
      <div className="job-summary">
        <div className="job-head">
          <span className="id">{run.caseLabel || run.project}</span>
          <h1 className="title">{run.title}</h1>
          <span className={`chip ${runState(run)}`}>{runLabel(run)}</span>
        </div>
        <div className="job-sub">
          <span>
            Started by <RunUser run={run} />
          </span>
          <span>
            {run.provider || 'Provider not recorded'}
            {run.model ? ` / ${run.model}` : ''}
          </span>
        </div>
        <div className="run-metrics">
          <div className="metric">
            <span>Created</span>
            <strong>{new Date(run.createdAt).toLocaleString()}</strong>
          </div>
          <div className="metric">
            <span>Duration</span>
            <strong>
              {run.startedAt && run.finishedAt
                ? duration(
                    Date.parse(run.finishedAt) - Date.parse(run.startedAt),
                  )
                : '—'}
            </strong>
          </div>
          <div className="metric">
            <span>Environment</span>
            <strong>{run.environmentName || 'Not recorded'}</strong>
          </div>
        </div>
        <div className="team-run-summary">
          <h2>Run updates</h2>
          <p>{run.summary || 'No run summary has been published yet.'}</p>
          <small>
            Last updated {new Date(run.updatedAt).toLocaleString()} · Revision{' '}
            {run.revision}
          </small>
        </div>
      </div>
      <p className="team-run-note">
        Execution and artifacts stay on the developer’s machine until worker
        synchronization is connected.
      </p>
    </article>
  );
}
