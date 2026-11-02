// Compiled only by browser tests and local review, never by the production build.
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from '../../src/team/client/workspace.tsx';
import { createApi } from '../../src/team/client/api.ts';
import { actorSchema, type Actor } from '../../src/team/contracts.ts';
import '../../src/team/client/styles.css';

const identityKey = 'team-review-identity';

function Fixture() {
  const [role, setRole] = useState(() => {
    const stored = sessionStorage.getItem(identityKey);
    return stored === 'viewer' || stored === 'signed-out' ? stored : 'member';
  });
  const [actor, setActor] = useState<Actor>();
  function changeIdentity(next: string) {
    sessionStorage.setItem(identityKey, next);
    setActor(undefined);
    setRole(next);
  }
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
    <div className="team-review">
      <div className="team-review-controls">
        <p role="note">
          Local review · Fixture identities · Real API and disposable database ·
          Clerk sign-in is not under test
        </p>
        <label style={{ maxWidth: 250 }}>
          Test identity
          <select value={role} onChange={(e) => changeIdentity(e.target.value)}>
            <option>member</option>
            <option>viewer</option>
            <option value="signed-out">Signed out</option>
          </select>
        </label>
      </div>
      {actor ? (
        <WorkspaceApp
          key={role}
          actor={actor}
          api={api}
          onAccessLost={() => changeIdentity('signed-out')}
        />
      ) : (
        <p>Signed out or loading identity</p>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
