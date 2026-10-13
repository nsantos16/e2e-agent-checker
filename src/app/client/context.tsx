import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createWorkspace, type Workspace, type WorkspaceState } from './workspace.ts';
// Components depend on state and actions; the provider owns subscriptions and runtime lifecycle.
type WorkspaceContextValue = { state: WorkspaceState; actions: Omit<Workspace, 'getSnapshot' | 'subscribe' | 'start'> };
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace] = useState(createWorkspace);
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  useEffect(() => workspace.start(), [workspace]);
  return <WorkspaceContext value={{ state, actions: workspace }}>{children}</WorkspaceContext>;
}
export function useWorkspace() {
  const value = use(WorkspaceContext);
  if (!value) throw new Error('Workspace provider is missing');
  return value;
}
