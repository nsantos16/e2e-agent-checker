// Compiled only by tests/team-browser.ts, never by the team production build.
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from '../../src/team/client/workspace.tsx';
import { createApi } from '../../src/team/client/api.ts';
import { actorSchema, type Actor } from '../../src/team/contracts.ts';
import '../../src/team/client/styles.css';

function Fixture() {
  const [role, setRole] = useState('member');
  const [actor, setActor] = useState<Actor>();
  const api = useMemo(() => createApi(async () => role), [role]);
  useEffect(() => {
    setActor(undefined);
    if (role === 'signed-out') return;
    const controller = new AbortController();
    void api('/me', actorSchema, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setActor(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, role]);
  return (
    <>
      <label style={{ maxWidth: 250 }}>
        Test identity
        <select
          value={role}
          onChange={(e) => {
            setActor(undefined);
            setRole(e.target.value);
          }}
        >
          <option>member</option>
          <option>viewer</option>
          <option value="signed-out">Signed out</option>
        </select>
      </label>
      {actor ? (
        <WorkspaceApp
          key={role}
          actor={actor}
          api={api}
          onAccessLost={() => {
            setActor(undefined);
            setRole('signed-out');
          }}
        />
      ) : (
        <p>Signed out or loading identity</p>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
