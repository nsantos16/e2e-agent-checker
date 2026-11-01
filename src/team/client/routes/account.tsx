import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useWorkspace } from '../context.tsx';
const sessionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      lastActiveAt: z.number(),
      current: z.boolean(),
    }),
  ),
});
export const Route = createFileRoute('/account')({ component: Account });
function Account() {
  const { api, actor, onAccessLost } = useWorkspace();
  const [sessions, setSessions] = useState<
    z.infer<typeof sessionsSchema>['items']
  >([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void api('/sessions', sessionsSchema, { signal: controller.signal })
      .then((s) => setSessions(s.items))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [api]);
  async function revoke(id: string) {
    setBusy(id);
    setError('');
    try {
      const response = await api(
        `/sessions/${id}`,
        z.object({ revoked: z.boolean(), current: z.boolean() }),
        { method: 'DELETE' },
      );
      if (response.current) onAccessLost();
      else
        setSessions((items) =>
          items.map((s) => (s.id === id ? { ...s, status: 'revoked' } : s)),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Your access</p>
          <h1>Account</h1>
          <p>
            {actor.name} · {actor.role} in {actor.organizationName}
          </p>
        </div>
      </header>
      <section className="editor">
        <h2>Sign-in sessions</h2>
        <p>Revoke access for a browser you no longer use.</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <ul className="sessions">
          {sessions.map((session) => (
            <li key={session.id}>
              <div>
                <strong>
                  {session.status}
                  {session.current ? ' · This browser' : ''}
                </strong>
                <p>
                  Last active {new Date(session.lastActiveAt).toLocaleString()}
                </p>
              </div>
              {session.status === 'active' && (
                <button
                  disabled={!!busy}
                  onClick={() => void revoke(session.id)}
                >
                  {busy === session.id ? 'Revoking…' : 'Revoke session'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
