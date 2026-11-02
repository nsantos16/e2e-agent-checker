import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { eq, useLiveQuery } from '@tanstack/react-db';
import { useWorkspace } from '../context.tsx';
import { RunThread } from '../runs.tsx';

export const Route = createFileRoute('/runs/$runId')({ component: RunDetails });
function RunDetails() {
  const { runId } = Route.useParams();
  return <RunDetailsContent key={runId} id={runId} />;
}
function RunDetailsContent({ id }: { id: string }) {
  const { runs } = useWorkspace();
  const search = Route.useSearch();
  const [error, setError] = useState('');
  const live = useLiveQuery({
    client: runs.db,
    query: (q) =>
      q
        .from({ run: runs.collection })
        .where(({ run }) => eq(run.id, id))
        .findOne(),
  });
  useEffect(() => {
    const controller = new AbortController();
    const release = runs.pin(id);
    const refresh = () =>
      void runs
        .loadOne(id, controller.signal)
        .then(() => {
          if (!controller.signal.aborted) setError('');
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      release();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [runs, id]);
  return (
    <>
      <Link className="team-back" to="/" search={search}>
        ← Back to runs
      </Link>
      {error && <p role="alert">{error}</p>}
      {live.data ? (
        <RunThread run={live.data} />
      ) : (
        !error && <p role="status">Loading run…</p>
      )}
    </>
  );
}
