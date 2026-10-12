import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from './config.ts';
import type { Job } from './jobs.ts';

// MCP surface for coding agents. The local app owns the job queue, so jobs an agent starts show up in the app UI too;
// this server forwards to the app's API and starts the app in the background when it isn't running.

const exec = promisify(execFile);
const root = new URL('..', import.meta.url).pathname;
const APP = `http://127.0.0.1:${config.app.port}`;

const appUp = () => fetch(`${APP}/api/config`, { signal: AbortSignal.timeout(1_500) }).then((r) => r.ok, () => false);

const ensureApp = async () => {
  if (await appUp()) return;
  spawn(process.execPath, [join(root, 'src/app/server.ts')], { detached: true, stdio: 'ignore', env: { ...process.env, E2E_APP_OPEN: '0' } }).unref();
  for (let i = 0; i < 40; i++) {
    if (await appUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The e2e-agent-checker app did not start on ${APP}`);
};

const appApi = async <T>(path: string, body?: unknown): Promise<T> => {
  await ensureApp();
  const res = await fetch(`${APP}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
};

const server = new McpServer({ name: 'e2e-agent-checker', version: '0.2.0' });
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

server.registerTool(
  'verify_case',
  {
    title: 'Verify a Qase test case against a worktree',
    description:
      'Starts a background job in the local e2e-agent-checker app: serves the frontend worktree against the shared dev API, has an agent execute the Qase case ' +
      'in a browser, codifies it into a Playwright spec, and replays that spec with video. Returns a jobId immediately; poll get_job (typically 3-10 minutes). ' +
      `Progress is also visible at http://localhost:${config.app.port}.`,
    inputSchema: {
      worktreePath: z.string().describe('Absolute path to a sample-frontend checkout or worktree'),
      qaseCaseId: z.number().int().positive().describe('Qase case id, e.g. 6003 for DEMO-6003'),
      project: z.string().default(config.qase.project).describe('Qase project code'),
      role: z.string().optional().describe('Test user role from config/roles.json'),
    },
  },
  async ({ worktreePath, qaseCaseId, project, role }) => {
    const [jobId] = await appApi<string[]>('/api/jobs', { worktree: worktreePath, cases: [{ project, id: qaseCaseId }], role });
    return text({ jobId, next: `Call get_job with jobId "${jobId}" in a few minutes.`, app: `http://localhost:${config.app.port}` });
  },
);

server.registerTool(
  'get_job',
  {
    title: 'Get a verification job',
    description: 'Status, current stage, per-step verdicts with evidence, replay result, MP4 path, PR comment, generated spec path, and cost.',
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => {
    const job = await appApi<Job & { comment?: string }>(`/api/jobs/${jobId}`);
    return text({ ...job, log: job.log.slice(-10) });
  },
);

server.registerTool(
  'list_jobs',
  { title: 'List verification jobs', description: 'Most recent first, with status and outcome.', inputSchema: {} },
  async () => {
    const jobs = await appApi<(Job & { title?: string })[]>('/api/jobs');
    return text(jobs.slice(0, 30).map((j) => ({ id: j.id, case: `${j.project}-${j.caseId}`, title: j.title, worktree: j.worktree, status: j.status, stage: j.stage, outcome: j.outcome, costUsd: j.costUsd })));
  },
);

server.registerTool(
  'attach_to_pr',
  {
    title: 'Attach verification evidence to a GitHub PR',
    description:
      "PUBLISHES to GitHub: posts the job's PR comment (step table + replay video) on the pull request, uploading the MP4 with `gh --attach`. " +
      'Uploaded attachments are viewable by anyone with the URL, even on private repos. Only call this when the user asked to publish.',
    inputSchema: { jobId: z.string(), pr: z.string().describe('PR number or URL') },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ jobId, pr }) => {
    const job = await appApi<Job>(`/api/jobs/${jobId}`);
    if (job.status !== 'done' || !job.prComment) return text(`Job ${jobId} has no finished evidence to attach`);
    const args = ['pr', 'comment', pr, '--body-file', job.prComment, ...(job.video ? ['--attach', job.video] : [])];
    const { stdout } = await exec('gh', args, { cwd: job.worktree });
    return text({ posted: stdout.trim(), body: readFileSync(job.prComment, 'utf8').slice(0, 2000) });
  },
);

await server.connect(new StdioServerTransport());
