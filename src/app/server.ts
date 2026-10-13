import { CaseRepository, EnvironmentRepository } from '../runtime/repositories.ts';
import { Cause, Effect } from 'effect';
import { runEffect, sdk } from '../runtime/effect.ts';
import { CheckerLive } from '../runtime/services.ts';
import { runMain } from '../runtime/main.ts';
import { execFile, execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { config, frontendRepo, requireFrontendRepo } from '../config.ts';
import { runDoctorEffect } from '../doctor.ts';
import { cancelJob, getJob, listJobs, replayJob, submitBatchEffect, shutdownJobsEffect } from '../jobs.ts';
import { fetchCasesEffect, loadCaseWithRelatedEffect } from '../qase.ts';
import { environmentSummary, environmentId } from '../environments.ts';
import { caseCatalog, caseSummary, syncCaseSchema } from '../cases.ts';
import { baseUrl, isHealthyEffect, listSlots } from '../slots.ts';

import { listProvidersEffect } from '../providers/index.ts';
import { z, ZodError } from 'zod';
import { artifactPath, jobSummary, readEvidence, type ArtifactId } from '../agent-view.ts';
import { liveFrame, readNetwork, readObservation } from '../observations.ts';

// Local app: list Qase cases, pick a worktree, run cases in parallel with agents, watch progress and replay videos.

const root = new URL('../..', import.meta.url).pathname;
const PORT = config.app.port;
const ROLES = Object.keys(JSON.parse(readFileSync(join(root, 'config/roles.json'), 'utf8')).roles);

const listCasesEffect = (includeArchived = false) =>
  Effect.flatMap(CaseRepository, (cases) => cases.list(includeArchived)).pipe(Effect.map((cases) => cases.map(caseSummary)));

const listWorktrees = () => {
  if (!frontendRepo()) return [];
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: requireFrontendRepo(),
    encoding: 'utf8',
  });
  return out
    .trim()
    .split('\n\n')
    .map((block) => {
      const get = (k: string) =>
        block
          .split('\n')
          .find((l) => l.startsWith(`${k} `))
          ?.slice(k.length + 1);
      const path = get('worktree')!;
      const branch = get('branch')?.replace('refs/heads/', '');
      const head = get('HEAD')?.slice(0, 10);
      const subject = execFileSync('git', ['log', '-1', '--format=%s', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
      return {
        path,
        branch: branch ?? `detached @ ${head}`,
        head,
        subject,
        hasDeps: existsSync(join(path, 'node_modules')),
      };
    })
    .filter((w) => existsSync(join(w.path, 'package.json')));
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage) => {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64_000) throw new Error('Request is too large');
  }
  return data ? JSON.parse(data) : {};
};

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

// Serves run artifacts only (videos, screenshots, comments, specs), never anything outside runs/ or e2e/generated/.
const serveFile = (req: IncomingMessage, res: ServerResponse, requested: string) => {
  if (!existsSync(requested)) return json(res, 404, { error: 'not found' });
  const path = realpathSync(requested);
  const allowed = [join(root, 'runs') + '/', join(root, 'e2e/generated') + '/'];
  if (
    !allowed.some((dir) => path.startsWith(dir)) ||
    !existsSync(path) ||
    !/(?:verification\.mp4|pr-comment\.md|[^/]+\.spec\.ts)$/.test(path)
  )
    return json(res, 404, { error: 'not found' });
  const size = statSync(path).size;
  const type = TYPES[extname(path)] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || (!range[1] && !range[2])) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    createReadStream(path, { start, end })
      .on('error', () => res.destroy())
      .pipe(res);
  } else {
    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'accept-ranges': 'bytes',
    });
    createReadStream(path)
      .on('error', () => res.destroy())
      .pipe(res);
  }
};

const titlesEffect = listCasesEffect().pipe(Effect.map((cases) => new Map(cases.map((c) => [`${c.project}-${c.id}`, c.title]))));

const handleRequest = (req: IncomingMessage, res: ServerResponse) =>
  Effect.gen(function* () {
    const cases = yield* CaseRepository;
    const environments = yield* EnvironmentRepository;
    if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host ?? '')) return json(res, 403, { error: 'Host not allowed' });
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (
      req.method === 'POST' &&
      req.headers.origin &&
      req.headers.origin !== `http://localhost:${PORT}` &&
      req.headers.origin !== `http://127.0.0.1:${PORT}`
    )
      return json(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(join(root, 'src/app/ui.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/config')
      return json(res, 200, {
        roles: ROLES,
        environments: (yield* environments.list()).map(environmentSummary),
        frontendRepo: frontendRepo(),
        defaultTarget: {
          provider: 'claude-code',
          model: config.model,
          authMode: 'subscription',
        },
      });
    if (req.method === 'GET' && url.pathname === '/api/environments')
      return json(
        res,
        200,
        url.searchParams.get('detail') === '1' ? yield* environments.list() : (yield* environments.list()).map(environmentSummary),
      );
    if (req.method === 'POST' && url.pathname === '/api/environments')
      return json(res, 200, environmentSummary(yield* environments.save(yield* sdk(() => readBody(req)))));
    const environmentMatch = url.pathname.match(/^\/api\/environments\/([a-z0-9_-]+)\/delete$/);
    if (req.method === 'POST' && environmentMatch) {
      const id = environmentId.parse(environmentMatch[1]);
      const { expectedRevision } = z
        .object({ expectedRevision: z.string().min(1) })
        .strict()
        .parse(yield* sdk(() => readBody(req)));
      if (listJobs().some((j) => (j.environmentId ?? 'local') === id && ['queued', 'running', 'cancelling'].includes(j.status)))
        return json(res, 409, {
          code: 'ENVIRONMENT_IN_USE',
          error: 'Wait for this environment’s active runs to finish before deleting it',
        });
      yield* environments.delete(id, expectedRevision);
      return json(res, 200, { id, deleted: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/providers')
      return json(res, 200, yield* listProvidersEffect(url.searchParams.get('fresh') === '1'));
    if (req.method === 'GET' && url.pathname === '/api/doctor')
      return json(
        res,
        200,
        yield* runDoctorEffect(url.searchParams.get('environmentId') ?? 'local', url.searchParams.get('userId') ?? undefined),
      );
    if (req.method === 'GET' && url.pathname === '/api/cases')
      return json(res, 200, yield* listCasesEffect(url.searchParams.get('includeArchived') === '1'));
    if (req.method === 'POST' && url.pathname === '/api/cases') {
      const { project, id } = z
        .object({
          project: z
            .string()
            .regex(/^[A-Z0-9_]+$/)
            .default(config.qase.project),
          id: z.number().int().positive(),
        })
        .parse(yield* sdk(() => readBody(req)));
      try {
        if (caseCatalog.get(project, id).source.kind !== 'qase')
          throw Object.assign(new Error('This ID belongs to a local case'), { code: 'SOURCE_CONFLICT' });
      } catch (e) {
        if ((e as any).code !== 'NOT_FOUND') throw e;
      }
      const { testCase, related } = yield* loadCaseWithRelatedEffect(project, Number(id));
      return json(res, 200, {
        id: testCase.id,
        title: testCase.title,
        related: related.length,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/cases/create')
      return json(res, 201, caseSummary(yield* cases.create(yield* sdk(() => readBody(req)))));
    if (req.method === 'POST' && url.pathname === '/api/cases/sync') {
      const input = syncCaseSchema.parse(yield* sdk(() => readBody(req)));
      const remote = (yield* fetchCasesEffect(input.project, [input.caseId]))[0];
      return json(res, 200, caseSummary(yield* cases.syncQase(remote, input.expectedRevision, input.overwriteLocal)));
    }
    const caseMatch = url.pathname.match(/^\/api\/cases\/([A-Z0-9_]+)\/(\d+)(?:\/(update|delete))?$/);
    if (caseMatch) {
      const [, project, id, action] = caseMatch;
      if (req.method === 'GET' && !action) return json(res, 200, yield* cases.get(project, Number(id)));
      if (req.method === 'POST' && action === 'update')
        return json(res, 200, caseSummary(yield* cases.update(project, Number(id), yield* sdk(() => readBody(req)))));
      if (req.method === 'POST' && action === 'delete')
        return json(res, 200, caseSummary(yield* cases.archive(project, Number(id), yield* sdk(() => readBody(req)))));
    }
    if (req.method === 'GET' && url.pathname === '/api/worktrees') {
      const slots = yield* Effect.forEach(
        listSlots(),
        (s) => isHealthyEffect(s).pipe(Effect.map((healthy) => ({ ...s, url: baseUrl(s), healthy }))),
        { concurrency: 8 },
      );
      return json(
        res,
        200,
        listWorktrees().map((w) => ({
          ...w,
          slot: slots.find((s) => s.worktree === w.path),
        })),
      );
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      return json(
        res,
        200,
        (yield* submitBatchEffect(yield* sdk(() => readBody(req)))).map((j) => j.id),
      );
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const t = url.searchParams.get('view') === 'summary' ? new Map() : yield* titlesEffect;
      const ids = url.searchParams.has('ids') ? new Set(url.searchParams.get('ids')!.split(',')) : undefined;
      const cursor = Math.max(0, Math.floor(Number(url.searchParams.get('cursor')) || 0));
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 60) || 60));
      return json(
        res,
        200,
        listJobs()
          .filter(
            (j) =>
              (!ids || ids.has(j.id)) &&
              (!url.searchParams.has('status') || j.status === url.searchParams.get('status')) &&
              (!url.searchParams.has('provider') || j.target?.provider === url.searchParams.get('provider')) &&
              (!url.searchParams.has('batchId') || j.batchId === url.searchParams.get('batchId')),
          )
          .slice(cursor, cursor + limit)
          .map((j) =>
            url.searchParams.get('view') === 'summary'
              ? jobSummary(j, `http://localhost:${PORT}`)
              : {
                  ...j,
                  caseSnapshot: undefined,
                  environmentSnapshot: undefined,
                  identityKey: undefined,
                  caseRevision: j.caseSnapshot?.revision,
                  title: j.caseSnapshot?.title ?? t.get(`${j.project}-${j.caseId}`),
                  log: j.log.slice(-6),
                  canReplay: !!j.runDir && existsSync(join(j.runDir, 'codify', `${j.project}-${j.caseId}.spec.ts`)),
                },
          ),
      );
    }
    const artifactMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/artifacts\/(case|report|spec|comment|video|trace|usage|pricing)$/);
    if (req.method === 'GET' && artifactMatch) {
      const job = getJob(artifactMatch[1]);
      const path = job && artifactPath(job, artifactMatch[2] as ArtifactId);
      if (!path)
        return json(res, 404, {
          code: 'ARTIFACT_MISSING',
          error: 'Artifact not available',
        });
      res.setHeader('cache-control', 'no-store');
      if (artifactMatch[2] === 'video') return serveFile(req, res, path);
      res.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${artifactMatch[2]}${extname(path)}"`,
        'content-length': statSync(path).size,
      });
      return createReadStream(path)
        .on('error', () => res.destroy())
        .pipe(res);
    }
    const evidenceMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/evidence$/);
    if (req.method === 'GET' && evidenceMatch) {
      const job = getJob(evidenceMatch[1]);
      if (!job) return json(res, 404, { error: 'unknown job', code: 'NOT_FOUND' });
      return json(
        res,
        200,
        readEvidence(job, `http://localhost:${PORT}`, {
          artifact: url.searchParams.get('artifact') ?? undefined,
          offset: Number(url.searchParams.get('offset')) || 0,
          limit: Number(url.searchParams.get('limit')) || 4000,
        }),
      );
    }
    const observationMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/(observation|frame|network)$/);
    if (req.method === 'GET' && observationMatch) {
      const job = getJob(observationMatch[1]);
      if (!job) return json(res, 404, { error: 'unknown job', code: 'NOT_FOUND' });
      res.setHeader('cache-control', 'no-store');
      if (observationMatch[2] === 'observation')
        return json(
          res,
          200,
          readObservation(job.runDir, ['running', 'cancelling'].includes(job.status), url.searchParams.get('errorsOnly') !== '0'),
        );
      if (observationMatch[2] === 'network') {
        if (url.searchParams.get('download') === '1') res.setHeader('content-disposition', `attachment; filename="${job.id}-network.json"`);
        return json(
          res,
          200,
          job.runDir
            ? readNetwork(job.runDir, {
                errorsOnly: url.searchParams.get('errorsOnly') !== '0',
                limit: Number(url.searchParams.get('limit')) || 50,
                stage: url.searchParams.get('stage') ?? undefined,
                offset: Number(url.searchParams.get('cursor')) || 0,
                requestId: url.searchParams.get('requestId') ?? undefined,
              })
            : {
                requests: [],
                capturedStages: [],
                total: 0,
                errorCount: 0,
                dropped: 0,
                matching: 0,
              },
        );
      }
      const path = job.runDir && liveFrame(job.runDir);
      if (!path)
        return json(res, 404, {
          error: 'No browser frame yet',
          code: 'FRAME_UNAVAILABLE',
        });
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return createReadStream(path)
        .on('error', () => res.destroy())
        .pipe(res);
    }
    const actionMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/(cancel|replay)$/);
    if (req.method === 'POST' && actionMatch)
      return json(res, 200, actionMatch[2] === 'cancel' ? cancelJob(actionMatch[1]) : replayJob(actionMatch[1]));
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = getJob(jobMatch[1]);
      if (!job) return json(res, 404, { error: 'unknown job', code: 'NOT_FOUND' });
      if (url.searchParams.get('view') === 'summary') return json(res, 200, jobSummary(job, `http://localhost:${PORT}`));
      const comment = job.prComment && existsSync(job.prComment) ? readFileSync(job.prComment, 'utf8') : undefined;
      const summary =
        job.runDir && existsSync(join(job.runDir, 'summary.json'))
          ? JSON.parse(readFileSync(join(job.runDir, 'summary.json'), 'utf8'))
          : undefined;
      return json(res, 200, {
        ...job,
        caseSnapshot: undefined,
        environmentSnapshot: undefined,
        identityKey: undefined,
        caseRevision: job.caseSnapshot?.revision,
        network: job.runDir ? readNetwork(job.runDir, { errorsOnly: true, limit: 10 }) : undefined,
        comment,
        spec: summary?.spec,
        notes:
          job.runDir && existsSync(join(job.runDir, 'explore/report.json'))
            ? JSON.parse(readFileSync(join(job.runDir, 'explore/report.json'), 'utf8')).notes
            : undefined,
      });
    }
    if (req.method === 'GET' && url.pathname === '/files') return serveFile(req, res, url.searchParams.get('path') ?? '');
    json(res, 404, { error: 'not found' });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        if (res.destroyed || res.headersSent) return;
        const error = Cause.squash(cause);
        const e = error as Error & { code?: string };
        json(
          res,
          error instanceof ZodError ? 400 : e.code === 'NOT_FOUND' ? 404 : e.code?.endsWith('CONFLICT') ? 409 : e.code ? 422 : 500,
          {
            error: e.message,
            code: e.code ?? (error instanceof ZodError ? 'INVALID_INPUT' : 'INTERNAL_ERROR'),
          },
        );
      }),
    ),
  );
const server = createServer((req, res) => {
  const controller = new AbortController();
  const disconnected = () => {
    if (!res.writableFinished) controller.abort(new Error('Client disconnected'));
  };
  res.once('close', disconnected);
  void runEffect(handleRequest(req, res).pipe(Effect.provide(CheckerLive)), controller.signal)
    .catch(() => {
      if (!res.destroyed) res.destroy();
    })
    .finally(() => res.removeListener('close', disconnected));
});
await runMain(
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => server),
        () =>
          Effect.gen(function* () {
            yield* shutdownJobsEffect;
            server.closeAllConnections();
            yield* sdk(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))).pipe(
              Effect.ignore,
            );
          }),
      );
      yield* sdk(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(PORT, '127.0.0.1', () => {
              server.removeListener('error', reject);
              resolve();
            });
          }),
      );
      const address = `http://localhost:${PORT}`;
      console.log(`e2e-agent-checker app: ${address}`);
      if (process.env.E2E_APP_OPEN !== '0') execFile('open', [address], () => {});
      yield* Effect.never;
    }),
  ),
);
