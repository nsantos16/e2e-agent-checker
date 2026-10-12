import { execFile, execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { config, requireFrontendRepo } from '../config.ts';
import { runDoctor } from '../doctor.ts';
import { getJob, listJobs, submitJob } from '../jobs.ts';
import { loadCaseWithRelated, type QaseCase } from '../qase.ts';
import { baseUrl, isHealthy, listSlots } from '../slots.ts';

// Local app: list Qase cases, pick a worktree, run cases in parallel with agents, watch progress and replay videos.

const root = new URL('../..', import.meta.url).pathname;
const PORT = config.app.port;
const ROLES = Object.keys(JSON.parse(readFileSync(join(root, 'config/roles.json'), 'utf8')).roles);

const fixturesDir = join(root, 'fixtures/qase');
const listCases = () =>
  readdirSync(fixturesDir)
    .filter((f) => /^[A-Z0-9_]+-\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as QaseCase)
    .map((c) => ({ project: c.project, id: c.id, title: c.title, suite: c.suite_path ?? '', priority: c.priority, steps: c.steps.length, url: c.url }))
    .sort((a, b) => a.suite.localeCompare(b.suite) || a.id - b.id);

const listWorktrees = () => {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: requireFrontendRepo(), encoding: 'utf8' });
  return out
    .trim()
    .split('\n\n')
    .map((block) => {
      const get = (k: string) => block.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
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
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
};

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.json': 'application/json' };

// Serves run artifacts only (videos, screenshots, comments, specs), never anything outside runs/ or e2e/generated/.
const serveFile = (req: IncomingMessage, res: ServerResponse, requested: string) => {
  const path = resolve(requested);
  const allowed = [join(root, 'runs') + '/', join(root, 'e2e/generated') + '/'];
  if (!allowed.some((dir) => path.startsWith(dir)) || !existsSync(path) || path.endsWith('trace.zip')) return json(res, 404, { error: 'not found' });
  const size = statSync(path).size;
  const type = TYPES[extname(path)] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    createReadStream(path).pipe(res);
  }
};

const titles = () => new Map(listCases().map((c) => [`${c.project}-${c.id}`, c.title]));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(join(root, 'src/app/ui.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { roles: ROLES, frontendRepo: requireFrontendRepo() });
    if (req.method === 'GET' && url.pathname === '/api/doctor') return json(res, 200, await runDoctor());
    if (req.method === 'GET' && url.pathname === '/api/cases') return json(res, 200, listCases());
    if (req.method === 'POST' && url.pathname === '/api/cases') {
      const { project = 'DEMO', id } = await readBody(req);
      const { testCase, related } = await loadCaseWithRelated(project, Number(id));
      return json(res, 200, { id: testCase.id, title: testCase.title, related: related.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/worktrees') {
      const slots = await Promise.all(listSlots().map(async (s) => ({ ...s, url: baseUrl(s), healthy: await isHealthy(s) })));
      return json(res, 200, listWorktrees().map((w) => ({ ...w, slot: slots.find((s) => s.worktree === w.path) })));
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const { cases, worktree, role = ROLES[0] } = await readBody(req);
      if (!worktree || !Array.isArray(cases) || !cases.length) return json(res, 400, { error: 'worktree and cases are required' });
      const jobs = cases.map((c: { project: string; id: number }) => submitJob({ project: c.project, caseId: Number(c.id), worktree, role }));
      return json(res, 200, jobs.map((j) => j.id));
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const t = titles();
      return json(res, 200, listJobs().slice(0, 60).map((j) => ({ ...j, title: t.get(`${j.project}-${j.caseId}`), log: j.log.slice(-6) })));
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = getJob(jobMatch[1]);
      if (!job) return json(res, 404, { error: 'unknown job' });
      const comment = job.prComment && existsSync(job.prComment) ? readFileSync(job.prComment, 'utf8') : undefined;
      const summary = job.runDir && existsSync(join(job.runDir, 'summary.json')) ? JSON.parse(readFileSync(join(job.runDir, 'summary.json'), 'utf8')) : undefined;
      return json(res, 200, { ...job, comment, spec: summary?.spec, notes: job.runDir && existsSync(join(job.runDir, 'explore/report.json')) ? JSON.parse(readFileSync(join(job.runDir, 'explore/report.json'), 'utf8')).notes : undefined });
    }
    if (req.method === 'GET' && url.pathname === '/files') return serveFile(req, res, url.searchParams.get('path') ?? '');
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://localhost:${PORT}`;
  console.log(`e2e-agent-checker app: ${address}`);
  if (process.env.E2E_APP_OPEN !== '0') execFile('open', [address], () => {});
});
