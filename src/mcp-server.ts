import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getJob, listJobs, submitJob, type Job } from './jobs.ts';
import { baseUrl, isHealthy, listSlots } from './slots.ts';

// MCP surface for coding agents: verify a Qase case against a worktree in the background, then attach the evidence to a PR.

const exec = promisify(execFile);
const server = new McpServer({ name: 'e2e-agent-checker', version: '0.1.0' });

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const publicJob = (j: Job) => ({ ...j, log: j.log.slice(-15) });

server.registerTool(
  'verify_case',
  {
    title: 'Verify a Qase test case against a worktree',
    description:
      'Starts a background job: serves the frontend worktree against the shared dev API, has an agent execute the Qase case in a browser, ' +
      'codifies it into a Playwright spec, and replays that spec with video. Returns a jobId immediately; poll get_job (typically 3-10 minutes).',
    inputSchema: {
      worktreePath: z.string().describe('Absolute path to a sample-frontend checkout or worktree'),
      qaseCaseId: z.number().int().positive().describe('Qase case id, e.g. 6003 for DEMO-6003'),
      project: z.string().default('DEMO').describe('Qase project code'),
      role: z.string().default('eugene').describe('Test user role from config/roles.json'),
    },
  },
  async ({ worktreePath, qaseCaseId, project, role }) => {
    const job = submitJob({ project, caseId: qaseCaseId, worktree: worktreePath, role });
    return text({ jobId: job.id, status: job.status, next: `Call get_job with jobId "${job.id}" in a few minutes.` });
  },
);

server.registerTool(
  'get_job',
  {
    title: 'Get a verification job',
    description: 'Status, current stage, per-step verdicts with evidence, replay result, MP4 path, PR comment path, and cost.',
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => {
    const job = getJob(jobId);
    return job ? text(publicJob(job)) : text(`Unknown job ${jobId}`);
  },
);

server.registerTool(
  'list_jobs',
  { title: 'List verification jobs', description: 'Most recent first, with status and outcome.', inputSchema: {} },
  async () => text(listJobs().slice(0, 30).map((j) => ({ id: j.id, case: `${j.project}-${j.caseId}`, worktree: j.worktree, status: j.status, stage: j.stage, outcome: j.outcome, costUsd: j.costUsd }))),
);

server.registerTool(
  'list_slots',
  { title: 'List running worktree slots', description: 'Each slot is a worktree served on its own localhost port.', inputSchema: {} },
  async () => text(await Promise.all(listSlots().map(async (s) => ({ ...s, url: baseUrl(s), healthy: await isHealthy(s) })))),
);

server.registerTool(
  'attach_to_pr',
  {
    title: 'Attach verification evidence to a GitHub PR',
    description:
      'PUBLISHES to GitHub: posts the job\'s PR comment (step table + replay video) on the pull request, uploading the MP4 with `gh --attach`. ' +
      'Uploaded attachments are viewable by anyone with the URL, even on private repos. Only call this when the user asked to publish.',
    inputSchema: {
      jobId: z.string(),
      pr: z.string().describe('PR number or URL'),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ jobId, pr }) => {
    const job = getJob(jobId);
    if (!job || job.status !== 'done' || !job.prComment) return text(`Job ${jobId} has no finished evidence to attach`);
    const args = ['pr', 'comment', pr, '--body-file', job.prComment, ...(job.video ? ['--attach', job.video] : [])];
    const { stdout } = await exec('gh', args, { cwd: job.worktree });
    return text({ posted: stdout.trim(), body: readFileSync(job.prComment, 'utf8').slice(0, 2000) });
  },
);

await server.connect(new StdioServerTransport());
