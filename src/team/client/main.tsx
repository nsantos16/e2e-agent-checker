import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ClerkProvider,
  SignIn,
  UserButton,
  OrganizationSwitcher,
  useAuth,
} from '@clerk/react';
import { actorSchema, type Actor } from '../contracts.ts';
import { createApi, TeamApiError } from './api.ts';
import './styles.css';
const WorkspaceApp = lazy(() =>
  import('./workspace.tsx').then((module) => ({
    default: module.WorkspaceApp,
  })),
);

function SessionWorkspace() {
  const { isLoaded, isSignedIn, userId, sessionId, orgId, getToken } =
    useAuth();
  const identity = `${userId}:${sessionId}:${orgId}`;
  const [state, setState] = useState<{
    identity: string;
    actor?: Actor;
    error?: string;
  }>();
  const [retry, setRetry] = useState(0);
  const api = useMemo(
    () =>
      createApi(getToken, () =>
        setState((current) =>
          current?.identity === identity
            ? {
                identity,
                error:
                  'Your team access has changed. Sign in again or contact your administrator.',
              }
            : current,
        ),
      ),
    [getToken, identity],
  );
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !orgId) return;
    const controller = new AbortController();
    void api('/me', actorSchema, { signal: controller.signal })
      .then((actor) => {
        if (!controller.signal.aborted) setState({ identity, actor });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ identity, error: error.message });
      });
    return () => controller.abort();
  }, [api, identity, isLoaded, isSignedIn, orgId, retry]);
  if (!isLoaded) return <p className="team-message">Loading sign-in…</p>;
  if (!isSignedIn)
    return (
      <main className="team-login">
        <h1>Your team’s verification workspace</h1>
        <p>Shared cases and results. Execution on your own machine.</p>
        <SignIn routing="hash" />
      </main>
    );
  return (
    <>
      {(state?.identity !== identity || !state?.actor) && (
        <div className="team-account-controls">
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </div>
      )}
      {!orgId ? (
        <p className="team-message">
          Choose your team organization to continue.
        </p>
      ) : state?.identity !== identity ? (
        <p className="team-message">Opening your workspace…</p>
      ) : state.error ? (
        <div className="team-message" role="alert">
          <p>{state.error}</p>
          <button
            onClick={() => {
              setState(undefined);
              setRetry((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : state.actor ? (
        <Suspense
          fallback={<p className="team-message">Opening your workspace…</p>}
        >
          <WorkspaceApp
            key={`${identity}:${state.actor.role}`}
            actor={state.actor}
            api={api}
            accountControls={
              <>
                <OrganizationSwitcher hidePersonal />
                <UserButton />
              </>
            }
            onAccessLost={() =>
              setState((current) =>
                current?.identity === identity
                  ? {
                      identity,
                      error:
                        'This sign-in session was revoked. Sign in again to continue.',
                    }
                  : current,
              )
            }
          />
        </Suspense>
      ) : null}
    </>
  );
}

async function mount() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const response = await fetch('/api/team/config');
    if (!response.ok)
      throw new TeamApiError(
        response.status,
        'The team service is unavailable.',
      );
    const { clerkPublishableKey } = await response.json();
    if (
      typeof clerkPublishableKey !== 'string' ||
      !clerkPublishableKey.startsWith('pk_')
    )
      throw new Error('Team sign-in is not configured.');
    root.render(
      <ClerkProvider
        publishableKey={clerkPublishableKey}
        signInFallbackRedirectUrl="/"
        signUpFallbackRedirectUrl="/"
      >
        <SessionWorkspace />
      </ClerkProvider>,
    );
  } catch (error) {
    root.render(
      <main className="team-message" role="alert">
        <h1>Workspace unavailable</h1>
        <p>{(error as Error).message}</p>
        <button onClick={() => location.reload()}>Try again</button>
      </main>,
    );
  }
}
void mount();
