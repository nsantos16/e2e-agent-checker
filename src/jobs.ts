import { CaseRepository, EnvironmentRepository } from './runtime/repositories.ts';
import { Cause, Effect, Exit, Fiber, Semaphore } from 'effect';
import { deadline, runEffect } from './runtime/effect.ts';
import { CheckerLive } from './runtime/services.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { assertRunnable, type TestCase } from './cases.ts';
import { getEnvironment, getTestUser, environmentSessionPath, testIdentityKey, type Environment } from './environments.ts';
import { loginSlotEffect } from './login.ts';
import { statSync } from 'node:fs';
import { config } from './config.ts';
import { ensureSlotForWorktreeEffect, baseUrl } from './slots.ts';
import { verifyEffect } from './verify.ts';
import { newRunDir } from './explore.ts';
import { preflightEffect, RunError, targetSchema, type Target } from './providers/index.ts';
import { claudeUsage, emptyUsage, mergeUsage, type Usage, type RunMetrics } from './usage.ts';

export type JobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type Job = {
  id: string;
  project: string;
  caseId: number;
  caseSnapshot?: TestCase;
  environmentId?: string;
  userId?: string;
  environmentSnapshot?: Environment;
  environment?: {
    id: string;
    name: string;
    kind: string;
    baseUrl?: string;
    revision: string;
    userId: string;
    userName: string;
  };
  identityKey?: string;
  worktree: string;
  role: string;
  slot?: string;
  status: JobStatus;
  stage?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  runDir?: string;
  outcome?: string;
  exploreVerdict?: string;
  steps?: any[];
  replay?: any;
  video?: string;
  prComment?: string;
  costUsd?: number | null;
  error?: string;
  errorCode?: string;
  log: string[];
  target?: Target;
  batchId?: string;
  replayOf?: string;
  confirmationReplay?: boolean;
  limits?: { timeoutMs: number; maxAttempts: number };
  usage?: Usage;
  stageMetrics?: Record<string, RunMetrics>;
  timing?: {
    queueMs: number;
    activeMs: number;
    stages: Record<string, number>;
  };
  idempotencyKey?: string;
  requestHash?: string;
};
const root = new URL('..', import.meta.url).pathname;
const jobsPath = process.env.E2E_JOBS_PATH ?? join(root, '.state/jobs.json');
const jobs = new Map<string, Job>(existsSync(jobsPath) ? JSON.parse(readFileSync(jobsPath, 'utf8')).map((j: Job) => [j.id, j]) : []);
const persist = () => {
  mkdirSync(resolve(jobsPath, '..'), { recursive: true });
  writeFileSync(jobsPath + '.tmp', JSON.stringify([...jobs.values()].slice(-1000), null, 2), { mode: 0o600 });
  renameSync(jobsPath + '.tmp', jobsPath);
};
let recovered = false;
for (const j of jobs.values())
  if (['queued', 'running', 'cancelling'].includes(j.status)) {
    j.status = 'interrupted';
    j.finishedAt = new Date().toISOString();
    j.error = 'Interrupted by server restart. Submit a new run to retry.';
    j.errorCode = 'INTERRUPTED';
    recovered = true;
  }
// Backfill only recorded stage usage. Historical auth and queue timings remain unknown.
for (const j of jobs.values()) {
  if (j.usage || !j.runDir) continue;
  const recorded: Record<string, RunMetrics> = {};
  for (const name of ['explore', 'codify']) {
    const path = join(j.runDir, name, 'metrics.json');
    if (!existsSync(path)) continue;
    try {
      const m = JSON.parse(readFileSync(path, 'utf8'));
      if (m.usage && typeof m.usage.input_tokens === 'number') recorded[name] = { ...m, usage: claudeUsage(m.usage, m.costUsd, true) };
    } catch {
      /* Missing historical data stays unknown. */
    }
  }
  if (Object.keys(recorded).length) {
    j.stageMetrics = recorded;
    j.usage = mergeUsage(Object.values(recorded).map((m) => m.usage));
    recovered = true;
  }
}
if (recovered) persist();
const queue: Job[] = [];
const controllers = new Map<string, AbortController>();
const active = new Set<Job>();
const fibers = new Map<string, Fiber.Fiber<void, never>>();
let stopping = false;
const finish = (job: Job) => {
  job.finishedAt = new Date().toISOString();
  persist();
};
const pump = () => {
  if (stopping) return;
  for (const job of [...queue]) {
    if (active.size >= config.app.maxParallel) return;
    // Serialize shared credential references and each environment/user session; retain legacy role locking.
    if (
      [...active].some((j) =>
        j.identityKey && job.identityKey
          ? j.identityKey === job.identityKey || (j.environmentId === job.environmentId && j.userId === job.userId)
          : j.role === job.role,
      ) ||
      [...active].filter((j) => j.worktree === job.worktree).length >= config.app.maxPerWorktree
    )
      continue;
    queue.splice(queue.indexOf(job), 1);
    active.add(job);
    const fiber = Effect.runFork(
      executeEffect(job).pipe(
        Effect.provide(CheckerLive),
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(job);
            fibers.delete(job.id);
            pump();
          }),
        ),
      ),
    );
    fibers.set(job.id, fiber);
  }
};
const executeEffect = (job: Job) =>
  Effect.suspend(() => {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    const signal = controller.signal;
    const started = performance.now();
    let stageStarted = started;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.timing = {
      queueMs: Date.now() - Date.parse(job.createdAt),
      activeMs: 0,
      stages: {},
    };
    job.stageMetrics = {};
    const stage = (next: string) => {
      if (job.stage) job.timing!.stages[job.stage] = (job.timing!.stages[job.stage] ?? 0) + performance.now() - stageStarted;
      stageStarted = performance.now();
      job.stage = next;
      persist();
    };
    const log = (line: string) => {
      job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
      job.log = job.log.slice(-80);
      persist();
    };
    const work = Effect.gen(function* () {
      stage('prepare');
      if (!job.replayOf) yield* preflightEffect(job.target!);
      signal.throwIfAborted();
      const environment = job.environmentSnapshot ?? (yield* (yield* EnvironmentRepository).get(job.environmentId));
      const user = getTestUser(environment, job.userId ?? job.role);
      let base: string, storageState: string, slotId: string;
      if (environment.kind === 'hosted') {
        base = environment.baseUrl!;
        slotId = `env-${environment.id}`;
        storageState = environmentSessionPath(environment, user, base);
        if (!existsSync(storageState) || Date.now() - statSync(storageState).mtimeMs > 6 * 60 * 60 * 1000) {
          log(`Preparing ${environment.name} / ${user.name}`);
          yield* loginSlotEffect({
            base,
            role: user.id,
            slot: slotId,
            user,
            storageState,
            signal,
          });
        }
      } else {
        const slot = yield* ensureSlotForWorktreeEffect(job.worktree, user.id, log, environment);
        base = baseUrl(slot);
        slotId = slot.slot;
        storageState = environmentSessionPath(environment, user, base);
      }
      signal.throwIfAborted();
      job.slot = slotId;
      job.runDir = newRunDir(job.project, job.caseId, slotId, job.replayOf ? 'replay' : 'verify');
      persist();
      const summary = yield* verifyEffect({
        project: job.project,
        caseId: job.caseId,
        caseSnapshot: job.caseSnapshot,
        slot: slotId,
        base,
        storageState,
        environmentId: environment.id,
        environmentRevision: environment.revision,
        userIdentity: testIdentityKey(user),
        role: job.role,
        model: job.target?.model ?? config.model,
        target: job.target,
        signal,
        maxAttempts: job.limits?.maxAttempts,
        runDir: job.runDir,
        fromRun: job.replayOf ? jobs.get(job.replayOf)?.runDir : undefined,
        replayOnly: !!job.replayOf,
        confirmationReplay: job.confirmationReplay,
        onStage: stage,
        onMetrics: (name, m) => {
          job.stageMetrics![name] = m;
          job.usage = mergeUsage(Object.values(job.stageMetrics!).map((v) => v.usage));
          job.costUsd = job.usage.providerReportedCostUsd;
          job.timing!.activeMs = performance.now() - started;
          writeFileSync(join(job.runDir!, 'usage.json'), JSON.stringify({ usage: job.usage, stages: job.stageMetrics }, null, 2));
          persist();
        },
        log,
      });
      signal.throwIfAborted();
      const report = JSON.parse(readFileSync(join(job.runDir, 'explore/report.json'), 'utf8'));
      Object.assign(job, {
        status: 'done',
        outcome: summary.outcome,
        exploreVerdict: report.verdict,
        steps: report.steps,
        replay: summary.replays?.[0],
        video: summary.replays?.[0]?.video,
        prComment: existsSync(join(job.runDir, 'pr-comment.md')) ? join(job.runDir, 'pr-comment.md') : undefined,
      });
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort(new RunError('CANCELLED', 'Run interrupted')))));
    return deadline(work, job.limits?.timeoutMs ?? 20 * 60_000, 'Run exceeded its time limit').pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) return;
          const failure = Cause.squash(exit.cause) as Error & { code?: string };
          const e = failure?.code === 'TIMEOUT' ? failure : signal.aborted ? signal.reason : failure;
          job.status =
            e?.code === 'TIMEOUT' ? 'failed' : e?.code === 'INTERRUPTED' ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed';
          job.error = String(e);
          job.errorCode = e?.code ?? 'RUN_FAILED';
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (job.usage?.status === 'pending') job.usage.status = 'unavailable';
          controllers.delete(job.id);
          job.timing!.activeMs = performance.now() - started;
          if (job.stage) job.timing!.stages[job.stage] = (job.timing!.stages[job.stage] ?? 0) + performance.now() - stageStarted;
          finish(job);
        }),
      ),
      Effect.ignoreCause,
    );
  });
export const shutdownJobsEffect = Effect.suspend(() => {
  stopping = true;
  for (const job of queue.splice(0)) {
    job.status = 'interrupted';
    job.errorCode = 'INTERRUPTED';
    finish(job);
  }
  for (const controller of controllers.values()) controller.abort(new RunError('INTERRUPTED', 'Server stopped'));
  return Fiber.interruptAll([...fibers.values()]);
});
export const shutdownJobs = () => runEffect(shutdownJobsEffect);
export const limitsSchema = z
  .object({
    timeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(60 * 60_000)
      .default(20 * 60_000),
    maxAttempts: z.number().int().min(1).max(8).default(8),
  })
  .strict();
export const batchSchema = z
  .object({
    cases: z
      .array(
        z
          .object({
            project: z.string().regex(/^[A-Z0-9_]+$/),
            id: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    worktree: z.string().min(1).optional(),
    environmentId: z.string().default('local'),
    userId: z.string().optional(),
    role: z.string().optional(),
    confirmationReplay: z.boolean().optional(),
    targets: z.array(targetSchema).min(1).max(8).optional(),
    limits: limitsSchema.default({ timeoutMs: 20 * 60_000, maxAttempts: 8 }),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
const submission = Semaphore.makeUnsafe(1);
export const submitBatchEffect = (input: unknown) => submission.withPermits(1)(submitBatchLockedEffect(input));
export const submitBatch = (input: unknown) => runEffect(submitBatchEffect(input).pipe(Effect.provide(CheckerLive)));
const submitBatchLockedEffect = (input: unknown) =>
  Effect.gen(function* () {
    if (stopping) return yield* Effect.fail(new RunError('APP_UNAVAILABLE', 'Server is stopping'));
    const b = batchSchema.parse(input);
    const environment = yield* (yield* EnvironmentRepository).get(b.environmentId);
    if (b.userId && b.role && b.userId !== b.role) throw new RunError('INVALID_INPUT', 'userId and legacy role must match');
    const user = getTestUser(environment, b.userId ?? b.role);
    const role = user.id;
    const worktree = b.worktree ? resolve(b.worktree) : '';
    if (environment.kind === 'worktree' && (!worktree || !existsSync(join(worktree, 'package.json'))))
      throw new RunError('FIXTURE_UNAVAILABLE', 'Select a frontend worktree for this environment');
    const targets = b.targets ?? [
      {
        provider: 'claude-code',
        model: config.model,
        authMode: 'subscription',
      },
    ];
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          ...b,
          worktree,
          role,
          targets,
          idempotencyKey: undefined,
        }),
      )
      .digest('hex');
    const existing = b.idempotencyKey ? [...jobs.values()].filter((j) => j.idempotencyKey === b.idempotencyKey) : [];
    if (existing.length) {
      if (existing[0].requestHash !== hash) throw new RunError('IDEMPOTENCY_CONFLICT', 'Key already used with different inputs');
      return existing;
    }
    const repository = yield* CaseRepository;
    const snapshots = yield* Effect.forEach(b.cases, (c) =>
      repository.get(c.project, c.id).pipe(Effect.tap((record) => Effect.sync(() => assertRunnable(record)))),
    );
    for (const t of targets) yield* preflightEffect(t);
    if (stopping) return yield* Effect.fail(new RunError('APP_UNAVAILABLE', 'Server is stopping'));
    const batchId = randomUUID();
    const created = b.cases.flatMap((c, index) =>
      targets.map(
        (target) =>
          ({
            id: `job-${randomUUID()}`,
            project: c.project,
            caseId: c.id,
            caseSnapshot: snapshots[index],
            worktree,
            role,
            confirmationReplay: b.confirmationReplay,
            environmentId: environment.id,
            userId: user.id,
            environmentSnapshot: environment,
            environment: {
              id: environment.id,
              name: environment.name,
              kind: environment.kind,
              baseUrl: environment.baseUrl,
              revision: environment.revision,
              userId: user.id,
              userName: user.name,
            },
            identityKey: testIdentityKey(user),
            target,
            batchId,
            limits: b.limits,
            idempotencyKey: b.idempotencyKey,
            requestHash: hash,
            status: 'queued' as const,
            createdAt: new Date().toISOString(),
            log: [],
            usage: emptyUsage(),
          }) satisfies Job,
      ),
    );
    for (const j of created) jobs.set(j.id, j);
    persist();
    queue.push(...created);
    pump();
    return created;
  });
export function cancelJob(id: string) {
  const j = jobs.get(id);
  if (!j) throw new RunError('NOT_FOUND', 'Unknown job');
  if (j.status === 'queued') {
    queue.splice(queue.indexOf(j), 1);
    j.status = 'cancelled';
    finish(j);
  } else if (j.status === 'running' || j.status === 'cancelling') {
    j.status = 'cancelling';
    controllers.get(id)?.abort(new RunError('CANCELLED', 'Cancelled by user'));
    const fiber = fibers.get(id);
    if (fiber) Effect.runFork(Fiber.interrupt(fiber));
    persist();
  }
  return j;
}
export function replayJob(id: string) {
  const old = jobs.get(id);
  if (!old?.runDir) throw new RunError('ARTIFACT_MISSING', 'Job has no saved run');
  if (['queued', 'running', 'cancelling'].includes(old.status)) throw new RunError('ARTIFACT_MISSING', 'Wait for the source run to finish');
  const file = join(old.runDir, 'codify', `${old.project}-${old.caseId}.spec.ts`);
  if (!existsSync(file) || !existsSync(join(old.runDir, 'explore/report.json')))
    throw new RunError('ARTIFACT_MISSING', 'Saved spec or report missing');
  const currentEnvironment = getEnvironment(old.environmentId);
  getTestUser(currentEnvironment, old.userId ?? old.role);
  const job: Job = {
    id: `job-${randomUUID()}`,
    project: old.project,
    caseId: old.caseId,
    caseSnapshot: old.caseSnapshot,
    worktree: old.worktree,
    role: old.role,
    environmentId: old.environmentId,
    userId: old.userId,
    environmentSnapshot: old.environmentSnapshot,
    environment: old.environment,
    identityKey: old.identityKey,
    target: old.target,
    limits: old.limits,
    replayOf: id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    log: [],
    usage: {
      ...emptyUsage('replay', 'complete'),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      providerReportedCostUsd: 0,
      estimatedApiCostUsd: 0,
    },
  };
  jobs.set(job.id, job);
  persist();
  queue.push(job);
  pump();
  return job;
}
export const getJob = (id: string) => jobs.get(id);
export const listJobs = () => [...jobs.values()].reverse();
