import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSlotForWorktree } from './slots.ts';
import { verify } from './verify.ts';

// Background verification jobs: one job per slot at a time, at most MAX_RUNNING overall (docs/adr/0003 caps parallelism).

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type Job = {
  id: string;
  project: string;
  caseId: number;
  worktree: string;
  role: string;
  slot?: string;
  status: JobStatus;
  stage?: string;
  createdAt: string;
  finishedAt?: string;
  runDir?: string;
  outcome?: string;
  exploreVerdict?: string;
  steps?: { position: number; verdict: string; inferred?: boolean; evidence: string }[];
  replay?: { status: string; failedStep?: string };
  video?: string;
  prComment?: string;
  costUsd?: number;
  error?: string;
  log: string[];
};

const root = new URL('..', import.meta.url).pathname;
const jobsPath = join(root, '.state/jobs.json');
const MAX_RUNNING = Number(process.env.E2E_MAX_PARALLEL ?? 4);

const jobs = new Map<string, Job>(existsSync(jobsPath) ? (JSON.parse(readFileSync(jobsPath, 'utf8')) as Job[]).map((j) => [j.id, j]) : []);
// Jobs interrupted by a restart can't resume mid-agent; mark them so callers re-submit.
for (const j of jobs.values()) if (j.status === 'queued' || j.status === 'running') Object.assign(j, { status: 'failed', error: 'interrupted by server restart' });

const persist = () => {
  mkdirSync(join(root, '.state'), { recursive: true });
  writeFileSync(jobsPath, JSON.stringify([...jobs.values()].slice(-200), null, 2));
};

const slotChains = new Map<string, Promise<void>>();
let running = 0;
const waiting: (() => void)[] = [];
const acquire = () => (running < MAX_RUNNING ? (running++, Promise.resolve()) : new Promise<void>((r) => waiting.push(() => (running++, r()))));
const release = () => {
  running--;
  waiting.shift()?.();
};

const sumCost = (summary: Record<string, unknown>) => {
  const e = (summary.explore as { metrics?: { costUsd?: number } })?.metrics?.costUsd ?? 0;
  const c = (summary.codify as { metrics?: { costUsd?: number } })?.metrics?.costUsd ?? 0;
  return +(e + c).toFixed(4);
};

const execute = async (job: Job) => {
  const log = (line: string) => {
    job.stage = line.trim().split(':')[0];
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    job.log = job.log.slice(-80);
    persist();
  };
  try {
    const slot = await ensureSlotForWorktree(job.worktree, job.role, log);
    job.slot = slot.slot;
    job.status = 'running';
    persist();
    const summary = await verify({ project: job.project, caseId: job.caseId, slot: slot.slot, model: process.env.E2E_MODEL ?? 'sonnet', log });
    const runDir = String(summary.runDir);
    const report = existsSync(join(runDir, 'explore/report.json')) ? JSON.parse(readFileSync(join(runDir, 'explore/report.json'), 'utf8')) : undefined;
    const replays = (summary.replays as { status: string; failedStep?: string; video?: string }[] | undefined) ?? [];
    Object.assign(job, {
      status: 'done',
      runDir,
      outcome: summary.outcome,
      exploreVerdict: report?.verdict,
      steps: report?.steps?.map((s: NonNullable<Job['steps']>[number]) => ({ position: s.position, verdict: s.verdict, inferred: s.inferred, evidence: s.evidence })),
      replay: replays[0] ? { status: replays[0].status, failedStep: replays[0].failedStep } : undefined,
      video: replays[0]?.video,
      prComment: existsSync(join(runDir, 'pr-comment.md')) ? join(runDir, 'pr-comment.md') : undefined,
      costUsd: sumCost(summary),
    });
  } catch (error) {
    Object.assign(job, { status: 'failed', error: String(error) });
  } finally {
    job.finishedAt = new Date().toISOString();
    persist();
  }
};

export const submitJob = (input: { project: string; caseId: number; worktree: string; role: string }) => {
  const id = `job-${Date.now().toString(36)}-${input.caseId}`;
  const job: Job = { id, ...input, status: 'queued', createdAt: new Date().toISOString(), log: [] };
  jobs.set(id, job);
  persist();
  // Serialise per worktree (a worktree maps to one slot) and bound overall concurrency.
  const key = input.worktree;
  const previous = slotChains.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    await acquire();
    try {
      await execute(job);
    } finally {
      release();
    }
  });
  slotChains.set(key, next.catch(() => {}));
  return job;
};

export const getJob = (id: string) => jobs.get(id);
export const listJobs = () => [...jobs.values()].reverse();
