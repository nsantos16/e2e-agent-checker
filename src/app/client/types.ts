import type { ExploreReport } from '../../explore.ts';
import type { Job } from '../../jobs.ts';
import type { Provider, Target } from '../../providers/index.ts';
import type { NetworkEntry as NetworkRequest } from '../../network.ts';
import type { readObservation, readNetwork } from '../../observations.ts';
export type { Provider, Target, NetworkRequest };
export type CaseSummary = { project: string; id: number; title: string; suite?: string; steps: number; status?: string; tags?: string[] };
export type JobView = Omit<Job, 'steps'> & {
  steps?: ExploreReport['steps'];
  title?: string;
  canReplay?: boolean;
  spec?: string;
  notes?: string;
};
export type TestUser = { id: string; name: string; usernameRef?: string; passwordRef?: string; totpRef?: string };
export type Environment = {
  id: string;
  name: string;
  kind: 'hosted' | 'worktree';
  baseUrl?: string;
  devMode?: string;
  revision?: string;
  users: TestUser[];
};
export type Worktree = { path: string; branch: string; subject: string; slot?: { port: number; healthy: boolean; url: string } };
export type Observation = ReturnType<typeof readObservation>;
export type Network = ReturnType<typeof readNetwork>;
export type Check = { name: string; ok: boolean; required: boolean; detail: string; fix?: string };
