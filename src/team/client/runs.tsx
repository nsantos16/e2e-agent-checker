import { useSyncExternalStore } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useLiveQuery } from '@tanstack/react-db';
import { useWorkspace } from './context.tsx';
import { runPageScope } from './runs-store.ts';
import type { TeamRun } from '../contracts.ts';
import { duration, outcomeLabel } from '../../app/client/format.ts';
import { JobSummary } from '../../app/client/components/JobCard.tsx';
import { SelectPicker } from '../../app/client/components/Picker.tsx';
import { Icon } from '../../app/client/components/Icon.tsx';

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
    <span title={run.initiatedBy.id}>
      {run.initiatedBy.name}
      {run.initiatedBy.id === actor.userId ? ' (you)' : ''}
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
  const current =
    page.scope ===
    runPageScope(search.userId, search.runAfter, search.runSearch);
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
    void navigate({
      to: '/',
      search: { search: '', userId, runSearch: search.runSearch },
    });
  return (
    <section
      className="team-run-overview"
      aria-label="Runs dashboard"
      aria-busy={page.loading}
    >
      <h1 className="eyebrow">Runs</h1>
      <div
        className="composer-toolbar team-run-controls"
        aria-label="Run filters"
      >
        <div className="environment-control">
          <SelectPicker
            id="run-user"
            label="Started by"
            className="control"
            value={search.userId ?? ''}
            placeholder="Selected user"
            onChange={(value) => filter(value || undefined)}
            options={[
              { value: '', label: 'All users' },
              ...users.map((user) => ({
                value: user.id,
                label: user.name + (user.id === actor.userId ? ' (you)' : ''),
                description: user.id.slice(0, 8),
              })),
            ]}
          />
        </div>
        <button
          className="control"
          onClick={() =>
            filter(search.userId === actor.userId ? undefined : actor.userId)
          }
        >
          {search.userId === actor.userId ? 'All users' : 'My runs'}
        </button>
        {search.userId && (
          <button
            className="icon-btn"
            aria-label="Clear user filter"
            title="Clear user filter"
            onClick={() => filter()}
          >
            <Icon name="close" />
          </button>
        )}
        <button
          className="control"
          disabled={page.loading}
          onClick={() =>
            void runs.loadPage(search.userId, search.runAfter, search.runSearch)
          }
        >
          Refresh runs
        </button>
      </div>
      <p className="metrics" aria-label="Run totals for selected user">
        <span aria-label="Total runs">{page.stats?.total ?? '—'}</span> runs ·{' '}
        {page.stats?.active ?? '—'} in progress · {page.stats?.passed ?? '—'}{' '}
        passed · {page.stats?.failed ?? '—'} failed
      </p>
      {page.error && (
        <p role="alert" className="error">
          Could not refresh runs: {page.error}{' '}
          <button
            onClick={() =>
              void runs.loadPage(
                search.userId,
                search.runAfter,
                search.runSearch,
              )
            }
          >
            Retry
          </button>
        </p>
      )}
      <div id="jobs" role="list" aria-label="Recent runs">
        {rows.map((run) => (
          <div role="listitem" key={run.id}>
            <RunThread run={run} compact />
          </div>
        ))}
      </div>
      {!rows.length && !page.error && (
        <div className="empty" role="status">
          {page.loading
            ? 'Loading runs…'
            : search.runSearch
              ? 'No matching runs. Adjust your search or user filter.'
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

export function RunThread({
  run,
  compact = false,
}: {
  run: TeamRun;
  compact?: boolean;
}) {
  const search = useSearch({ from: '__root__' });
  return (
    <article className="job" aria-label={compact ? run.title : 'Run thread'}>
      <JobSummary
        label={run.caseLabel || run.project}
        state={runState(run)}
        title={
          compact ? (
            <Link
              className="team-run-title"
              to="/runs/$runId"
              params={{ runId: run.id }}
              search={search}
            >
              {run.title}
            </Link>
          ) : (
            run.title
          )
        }
      >
        <div className="job-sub">
          <span>
            Started by <RunUser run={run} />
          </span>
          <span>{run.caseLabel || run.project}</span>
          <span>
            {run.provider || 'Provider not recorded'}
            {run.model ? ` / ${run.model}` : ''}
          </span>
          <time dateTime={run.createdAt}>
            {new Date(run.createdAt).toLocaleString()}
          </time>
        </div>
        {!compact && (
          <>
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
            <div className="notes">
              <div className="eyebrow">Run updates</div>
              <p>{run.summary || 'No run summary has been published yet.'}</p>
              <p className="metrics">
                Last updated {new Date(run.updatedAt).toLocaleString()} ·
                Revision {run.revision}
              </p>
            </div>
          </>
        )}
      </JobSummary>
    </article>
  );
}
