import { useEffect, useState, type ReactNode } from 'react';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { DbProvider } from '@tanstack/react-db';
import type { Actor } from '../contracts.ts';
import type { TeamApi } from './api.ts';
import { createCasesStore } from './cases-store.ts';
import { createRunsStore } from './runs-store.ts';
import { WorkspaceContext, type Workspace } from './context.tsx';
import { routeTree } from './routeTree.gen.ts';
import { WorkspaceProvider } from '../../app/client/context.tsx';

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
  accountControls,
}: {
  actor: Actor;
  api: TeamApi;
  onAccessLost: () => void;
  accountControls?: ReactNode;
}) {
  const [workspace] = useState<Workspace>(() => ({
    actor,
    api,
    onAccessLost,
    accountControls,
    cases: createCasesStore(api, `${actor.userId}:${actor.orgId}`),
    runs: createRunsStore(api, `${actor.userId}:${actor.orgId}`),
  }));
  const [router] = useState(createTeamRouter);
  useEffect(
    () => () => {
      void workspace.cases.dispose();
      void workspace.runs.dispose();
    },
    [workspace],
  );
  return (
    <WorkspaceContext value={workspace}>
      <DbProvider client={workspace.cases.db}>
        <WorkspaceProvider localExecution={false}>
          <RouterProvider router={router} />
        </WorkspaceProvider>
      </DbProvider>
    </WorkspaceContext>
  );
}
