import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from './config.ts';
import { targetSchema, providerId } from './providers/index.ts';
const exec = promisify(execFile),
  root = new URL('..', import.meta.url).pathname,
  APP = `http://127.0.0.1:${config.app.port}`;
const appUp = () =>
  fetch(`${APP}/api/config`, { signal: AbortSignal.timeout(1500) }).then(
    (r) => r.ok,
    () => false,
  );
async function ensureApp() {
  if (await appUp()) return;
  spawn(process.execPath, [join(root, 'src/app/server.ts')], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, E2E_APP_OPEN: '0' },
  }).unref();
  for (let i = 0; i < 40; i++) {
    if (await appUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Local app did not start');
}
async function api(path: string, body?: unknown): Promise<any> {
  await ensureApp();
  const r = await fetch(APP + path, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error), { code: data.code });
  return data;
}
const server = new McpServer({ name: 'e2e-agent-checker', version: '0.3.0' });
const jobSchema = z
  .object({
    id: z.string(),
    project: z.string(),
    caseId: z.number(),
    status: z.enum(['queued', 'running', 'cancelling', 'done', 'failed', 'cancelled', 'interrupted']),
    createdAt: z.string(),
    log: z.array(z.string()),
  })
  .passthrough();
const providerSchema = z
  .object({
    id: providerId,
    name: z.string(),
    installed: z.boolean(),
    auth: z.enum(['subscription', 'api-key', 'unknown', 'logged-out']),
    ready: z.boolean(),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
  })
  .passthrough();
const outputs: Record<string, z.ZodType> = {
  list_providers: z.object({ providers: z.array(providerSchema) }),
  list_models: providerSchema,
  list_cases: z.object({ cases: z.array(z.object({ project: z.string(), id: z.number(), title: z.string() }).passthrough()) }),
  list_worktrees: z.object({ worktrees: z.array(z.object({ path: z.string(), branch: z.string() }).passthrough()) }),
  verify_case: z.object({ jobId: z.string() }),
  verify_cases: z.object({ jobIds: z.array(z.string()) }),
  get_job: jobSchema,
  cancel_job: jobSchema,
  replay_job: z.object({ jobId: z.string() }),
  list_jobs: z.object({ jobs: z.array(jobSchema), nextCursor: z.number().nullable() }),
  attach_to_pr: z.object({ posted: z.string().optional(), alreadyPublished: z.boolean().optional(), pr: z.string().optional() }),
};
function register(name: string, description: string, inputSchema: any, fn: (args: any) => Promise<unknown>) {
  const outputSchema = z.object({ data: outputs[name] });
  server.registerTool(name, { description, inputSchema, outputSchema }, async (args: any) => {
    try {
      const data = outputs[name].parse(await fn(args));
      return { structuredContent: { data }, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ code: (e as any).code ?? 'RUN_FAILED', message: String(e) }) }],
      };
    }
  });
}
const limits = z
  .object({ timeoutMs: z.number().int().min(10_000).max(3600000).optional(), maxAttempts: z.number().int().min(1).max(8).optional() })
  .optional();
const common = {
  worktreePath: z.string().min(1),
  role: z.string().optional(),
  limits,
  idempotencyKey: z.string().min(1).max(128).optional(),
};
register('list_providers', 'Inspect native subscription authentication, capabilities, and model availability.', {}, async () => ({
  providers: await api('/api/providers'),
}));
register(
  'list_models',
  'List models for a native runtime. Availability is checked again before execution.',
  { provider: providerId },
  async ({ provider }) => {
    const p = (await api('/api/providers')).find((p: any) => p.id === provider);
    return { provider, ...p };
  },
);
register('list_cases', 'List locally imported Qase cases.', {}, async () => ({ cases: await api('/api/cases') }));
register('list_worktrees', 'List available frontend worktrees and dev-server slots.', {}, async () => ({
  worktrees: await api('/api/worktrees'),
}));
register(
  'verify_case',
  'Start one background Explore → Codify → Replay job. Uses existing subscriptions only; poll get_job.',
  {
    ...common,
    qaseCaseId: z.number().int().positive(),
    project: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .default(config.qase.project),
    target: targetSchema.optional(),
  },
  async ({ worktreePath, qaseCaseId, project, target, ...rest }) => ({
    jobId: (
      await api('/api/jobs', {
        worktree: worktreePath,
        cases: [{ project, id: qaseCaseId }],
        targets: target ? [target] : undefined,
        ...rest,
      })
    )[0],
  }),
);
register(
  'verify_cases',
  'Atomically preflight and queue every case × model combination. Jobs sharing an identity run sequentially.',
  {
    ...common,
    cases: z
      .array(z.object({ project: z.string().regex(/^[A-Z0-9_]+$/), id: z.number().int().positive() }))
      .min(1)
      .max(30),
    targets: z.array(targetSchema).min(1).max(8),
  },
  async ({ worktreePath, ...rest }) => ({ jobIds: await api('/api/jobs', { worktree: worktreePath, ...rest }) }),
);
register(
  'get_job',
  'Read status, stage timings, partial usage, evidence paths and bounded logs. Billed cost may be unavailable.',
  { jobId: z.string(), logLimit: z.number().int().min(0).max(80).default(10) },
  async ({ jobId, logLimit }) => {
    const j = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    return { ...j, log: logLimit ? j.log.slice(-logLimit) : [] };
  },
);
register(
  'list_jobs',
  'List recent jobs with optional status/provider/batch filters and offset cursor.',
  {
    status: z.string().optional(),
    provider: providerId.optional(),
    batchId: z.string().optional(),
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(60).default(30),
  },
  async ({ status, provider, batchId, cursor, limit }) => {
    const jobs = (await api('/api/jobs?limit=1000')).filter(
      (j: any) => (!status || j.status === status) && (!provider || j.target?.provider === provider) && (!batchId || j.batchId === batchId),
    );
    return { jobs: jobs.slice(cursor, cursor + limit), nextCursor: cursor + limit < jobs.length ? cursor + limit : null };
  },
);
register(
  'cancel_job',
  'Cancel a queued or running job. Idempotent; retains partial metrics and artifacts.',
  { jobId: z.string() },
  async ({ jobId }) => api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {}),
);
register(
  'replay_job',
  'Create a fresh replay of the saved spec with zero new model calls. Fails if the spec is missing.',
  { jobId: z.string() },
  async ({ jobId }) => ({ jobId: (await api(`/api/jobs/${encodeURIComponent(jobId)}/replay`, {})).id }),
);
register(
  'attach_to_pr',
  'PUBLISH evidence to GitHub only when explicitly requested. Attachments are accessible to anyone with their URL.',
  { jobId: z.string(), pr: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/), publish: z.literal(true) },
  async ({ jobId, pr }) => {
    const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (job.status !== 'done' || !job.prComment) throw new Error('ARTIFACT_MISSING: no completed evidence');
    const parts = new URL(pr).pathname.split('/');
    const repo = `${parts[1]}/${parts[2]}`,
      number = parts[4];
    const marker = `e2e-job:${jobId}`;
    const { stdout: comments } = await exec('gh', ['api', `repos/${repo}/issues/${number}/comments`, '--paginate']);
    // gh concatenates pages; query exact marker before publishing to avoid duplicate evidence on retries.
    if (comments.includes(marker)) return { alreadyPublished: true, pr };
    const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'e2e-publish-'));
    try {
      const body = join(dir, 'comment.md');
      writeFileSync(body, readFileSync(job.prComment, 'utf8') + `\n<!-- ${marker} -->\n`);
      const r = await exec('gh', ['pr', 'comment', pr, '--body-file', body, ...(job.video ? ['--attach', job.video] : [])], {
        cwd: job.worktree,
      });
      return { posted: r.stdout.trim() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
await server.connect(new StdioServerTransport());
