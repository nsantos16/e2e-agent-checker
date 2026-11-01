import { createContext, useContext } from 'react';
import type { Actor } from '../contracts.ts';
import type { CasesStore } from './cases-store.ts';
import type { TeamApi } from './api.ts';
export type Workspace = {
  actor: Actor;
  cases: CasesStore;
  api: TeamApi;
  onAccessLost: () => void;
};
export const WorkspaceContext = createContext<Workspace | null>(null);
export const useWorkspace = () => {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace unavailable');
  return value;
};
