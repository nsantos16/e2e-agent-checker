import { useEffect, useState } from 'react';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { DbProvider } from '@tanstack/react-db';
import type { Actor } from '../contracts.ts';
import type { TeamApi } from './api.ts';
import { createCasesStore } from './cases-store.ts';
import { WorkspaceContext, type Workspace } from './context.tsx';
import { routeTree } from './routeTree.gen.ts';

export function createTeamRouter() {
  return createRouter({ routeTree, defaultPreload: 'intent' });
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createTeamRouter>;
  }
}

export function WorkspaceApp({
  actor,
  api,
  onAccessLost,
}: {
  actor: Actor;
  api: TeamApi;
  onAccessLost: () => void;
}) {
  const [workspace] = useState<Workspace>(() => ({
    actor,
    api,
    onAccessLost,
    cases: createCasesStore(api, `${actor.userId}:${actor.orgId}`),
  }));
  const [router] = useState(createTeamRouter);
  useEffect(
    () => () => {
      void workspace.cases.dispose();
    },
    [workspace],
  );
  return (
    <WorkspaceContext value={workspace}>
      <DbProvider client={workspace.cases.db}>
        <RouterProvider router={router} />
      </DbProvider>
    </WorkspaceContext>
  );
}
