import { randomUUID } from 'node:crypto';
import type { Job } from './jobs.ts';
import { addSessionRunsSchema, createSessionSchema, sessionIdSchema } from './demo-contract.ts';
import { fail, readState, stateFile, writeState } from './local-state.ts';

export type RunSession = {
  id: string;
  title: string;
  jobIds: string[];
  revision: string;
  createdAt: string;
  source: 'explicit' | 'batch' | 'legacy';
};
const read = () => readState<RunSession[]>(stateFile('sessions.json'), []);
const save = (sessions: RunSession[]) => writeState(stateFile('sessions.json'), sessions);

// Membership uses recorded identifiers only. Never infer relationships from dates, paths or cases.
export function primarySessionId(job: Job, all: Job[] = [], seen = new Set<string>()): string {
  if (job.sessionId) return job.sessionId;
  if (job.batchId) return job.batchId;
  if (job.replayOf && !seen.has(job.id)) {
    seen.add(job.id);
    const source = all.find((j) => j.id === job.replayOf);
    if (source) return primarySessionId(source, all, seen);
  }
  return job.id;
}
export function syncSessions(jobs: Job[]) {
  const sessions = read();
  let changed = false;
  for (const job of jobs) {
    const id = primarySessionId(job, jobs);
    let session = sessions.find((s) => s.id === id);
    if (!session) {
      session = {
        id,
        title: job.batchId ? `Verification batch ${id}` : `Verification ${job.project}-${job.caseId}`,
        jobIds: [],
        revision: randomUUID(),
        createdAt: job.createdAt,
        source: job.batchId ? 'batch' : 'legacy',
      };
      sessions.push(session);
    }
    if (!session.jobIds.includes(job.id)) {
      session.jobIds.push(job.id);
      session.revision = randomUUID();
      changed = true;
    }
  }
  if (changed) save(sessions);
  return sessions;
}
export const getSession = (id: string) => read().find((s) => s.id === sessionIdSchema.parse(id)) ?? fail('NOT_FOUND', 'Unknown session');
export const listSessions = () => read().reverse();
function validateJobs(ids: string[], jobs: Job[]) {
  if (ids.some((id) => !jobs.some((j) => j.id === id))) fail('NOT_FOUND', 'One or more run IDs were not found');
}
export function createSession(input: unknown, jobs: Job[]) {
  const { title, jobIds } = createSessionSchema.parse(input);
  validateJobs(jobIds, jobs);
  const session: RunSession = {
    id: `session-${randomUUID()}`,
    title,
    jobIds: [...new Set(jobIds)],
    revision: randomUUID(),
    createdAt: new Date().toISOString(),
    source: 'explicit',
  };
  save([...read(), session]);
  return session;
}
export function addSessionRuns(id: string, input: unknown, jobs: Job[]) {
  const { expectedRevision, jobIds } = addSessionRunsSchema.parse(input);
  validateJobs(jobIds, jobs);
  const sessions = read(),
    session = sessions.find((s) => s.id === id) ?? fail('NOT_FOUND', 'Unknown session');
  if (session.revision !== expectedRevision) fail('REVISION_CONFLICT', 'Session membership changed; reload before adding runs');
  const merged = [...new Set([...session.jobIds, ...jobIds])];
  if (merged.length > 1000) fail('INVALID_INPUT', 'A session supports at most 1000 runs');
  session.jobIds = merged;
  session.revision = randomUUID();
  save(sessions);
  return session;
}
