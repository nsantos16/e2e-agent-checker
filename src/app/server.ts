import { execFile, execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { config, requireFrontendRepo } from '../config.ts';
import { runDoctor } from '../doctor.ts';
import { cancelJob, getJob, listJobs, replayJob, submitBatch } from '../jobs.ts';
import { loadCaseWithRelated, type QaseCase } from '../qase.ts';
import { baseUrl, isHealthy, listSlots } from '../slots.ts';

import { listProviders } from '../providers/index.ts';
import { ZodError } from 'zod';
import { liveFrame, readNetwork, readObservation } from '../observations.ts';

// Local app: list Qase cases, pick a worktree, run cases in parallel with agents, watch progress and replay videos.

const root = new URL('../..', import.meta.url).pathname;
const PORT = config.app.port;
const ROLES = Object.keys(JSON.parse(readFileSync(join(root, 'config/roles.json'), 'utf8')).roles);

const fixturesDir = join(root, 'fixtures/qase');
const listCases = () =>
  readdirSync(fixturesDir)
    .filter((f) => /^[A-Z0-9_]+-\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as QaseCase)
    .map((c) => ({
      project: c.project,
      id: c.id,
      title: c.title,
      suite: c.suite_path ?? '',
      priority: c.priority,
      steps: c.steps.length,
      url: c.url,
    }))
    .sort((a, b) => a.suite.localeCompare(b.suite) || a.id - b.id);

const listWorktrees = () => {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: requireFrontendRepo(), encoding: 'utf8' });
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
      return { path, branch: branch ?? `detached @ ${head}`, head, subject, hasDeps: existsSync(join(path, 'node_modules')) };
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
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    createReadStream(path)
      .on('error', () => res.destroy())
      .pipe(res);
  }
};

const titles = () => new Map(listCases().map((c) => [`${c.project}-${c.id}`, c.title]));

const server = createServer(async (req, res) => {
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host ?? '')) return json(res, 403, { error: 'Host not allowed' });
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
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
      return json(res, 200, { roles: ROLES, frontendRepo: requireFrontendRepo() });
    if (req.method === 'GET' && url.pathname === '/api/providers')
      return json(res, 200, await listProviders(url.searchParams.get('fresh') === '1'));
    if (req.method === 'GET' && url.pathname === '/api/doctor') return json(res, 200, await runDoctor());
    if (req.method === 'GET' && url.pathname === '/api/cases') return json(res, 200, listCases());
    if (req.method === 'POST' && url.pathname === '/api/cases') {
      const { project = 'DEMO', id } = await readBody(req);
      const { testCase, related } = await loadCaseWithRelated(project, Number(id));
      return json(res, 200, { id: testCase.id, title: testCase.title, related: related.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/worktrees') {
      const slots = await Promise.all(listSlots().map(async (s) => ({ ...s, url: baseUrl(s), healthy: await isHealthy(s) })));
      return json(
        res,
        200,
        listWorktrees().map((w) => ({ ...w, slot: slots.find((s) => s.worktree === w.path) })),
      );
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      return json(
        res,
        200,
        (await submitBatch(await readBody(req))).map((j) => j.id),
      );
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const t = titles();
      return json(
        res,
        200,
        listJobs()
          .slice(0, Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 60) || 60)))
          .map((j) => ({
            ...j,
            title: t.get(`${j.project}-${j.caseId}`),
            log: j.log.slice(-6),
            canReplay: !!j.runDir && existsSync(join(j.runDir, 'codify', `${j.project}-${j.caseId}.spec.ts`)),
          })),
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
              })
            : { requests: [], capturedStages: [], total: 0, errorCount: 0, dropped: 0, matching: 0 },
        );
      }
      const path = job.runDir && liveFrame(job.runDir);
      if (!path) return json(res, 404, { error: 'No browser frame yet', code: 'FRAME_UNAVAILABLE' });
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
      const comment = job.prComment && existsSync(job.prComment) ? readFileSync(job.prComment, 'utf8') : undefined;
      const summary =
        job.runDir && existsSync(join(job.runDir, 'summary.json'))
          ? JSON.parse(readFileSync(join(job.runDir, 'summary.json'), 'utf8'))
          : undefined;
      return json(res, 200, {
        ...job,
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
  } catch (error) {
    const e = error as Error & { code?: string };
    json(res, error instanceof ZodError ? 400 : e.code ? 422 : 500, {
      error: e.message,
      code: e.code ?? (error instanceof ZodError ? 'INVALID_INPUT' : 'INTERNAL_ERROR'),
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://localhost:${PORT}`;
  console.log(`e2e-agent-checker app: ${address}`);
  if (process.env.E2E_APP_OPEN !== '0') execFile('open', [address], () => {});
});
