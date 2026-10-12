import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config, qaseToken } from './config.ts';
import { caseCatalog, type TestCase } from './cases.ts';

// Read-only access to Qase through the official Qase MCP server, run locally with the dev's own API token.

export type QaseStep = { position: number; action: string | null; expected_result: string | null; data: string | null };
export type QaseCase = {
  project: string;
  id: number;
  url: string;
  title: string;
  suite_path?: string;
  priority?: number;
  severity?: number;
  preconditions: string | null;
  description: string | null;
  steps: QaseStep[];
};

const root = new URL('..', import.meta.url).pathname;
export const fixturePath = (project: string, id: number) => join(root, 'fixtures/qase', `${project}-${id}.json`);

const withQaseMcp = async <T>(fn: (call: (tool: string, args: object) => Promise<string>) => Promise<T>): Promise<T> => {
  const token = qaseToken();
  if (!token)
    throw new Error(
      `No Qase API token. Set ${config.qase.tokenEnv} or run: security add-generic-password -s ${config.qase.keychainService} -a "$USER" -w`,
    );
  const client = new Client({ name: 'e2e-agent-checker', version: '0.5.0' });
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', config.qase.mcpPackage],
    stderr: 'ignore',
    env: { ...process.env, QASE_API_TOKEN: token } as Record<string, string>,
  });
  try {
    await client.connect(transport);
    return await fn(async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args as Record<string, unknown> });
      if (result.isError) throw new Error(`Qase ${tool} failed`);
      return (result.content as { type: string; text?: string }[])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
    });
  } finally {
    await client.close();
  }
};

const FIELDS = ['id', 'title', 'priority', 'severity', 'steps', 'preconditions', 'description'];

const toCase = (project: string, raw: string): QaseCase => {
  const c = z
    .object({
      id: z.number().int().positive(),
      title: z.string().min(1),
      priority: z.number().optional(),
      severity: z.number().optional(),
      preconditions: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      steps: z
        .array(
          z.object({
            position: z.number().int().positive(),
            action: z.string().nullable(),
            expected_result: z.string().nullable(),
            data: z.string().nullable().optional(),
          }),
        )
        .optional(),
    })
    .parse(JSON.parse(raw));
  return {
    project,
    id: c.id,
    url: `https://app.qase.io/case/${project}-${c.id}`,
    title: c.title,
    priority: c.priority,
    severity: c.severity,
    preconditions: c.preconditions ?? null,
    description: c.description ?? null,
    steps: (c.steps ?? []).map((s) => ({
      position: s.position,
      action: s.action,
      expected_result: s.expected_result,
      data: s.data ?? null,
    })),
  };
};

export const fetchCases = (project: string, ids: number[]) =>
  withQaseMcp(async (call) => {
    const out: QaseCase[] = [];
    for (const id of ids) {
      const c = toCase(project, await call('qase_get', { entity: 'case', code: project, id, fields: FIELDS }));
      if (c.id !== id) throw new Error('Qase returned a different case ID');
      out.push(c);
    }
    return out;
  });

export const linkedCaseIds = (c: QaseCase) => {
  const text = `${c.preconditions ?? ''}\n${c.description ?? ''}\n${c.steps.map((s) => `${s.action}\n${s.expected_result}`).join('\n')}`;
  return [...new Set([...text.matchAll(new RegExp(`${c.project}-(\\d+)`, 'g'))].map((m) => Number(m[1])))].filter((id) => id !== c.id);
};

// The case plus a short summary of every Qase case its text links to (they usually describe how to reach a page).
export const loadCaseWithRelated = async (project: string, id: number, snapshot?: TestCase) => {
  let c = snapshot;
  if (!c) {
    try {
      c = caseCatalog.get(project, id);
    } catch (e) {
      if ((e as any).code !== 'NOT_FOUND') throw e;
      c = caseCatalog.syncQase((await fetchCases(project, [id]))[0]);
    }
  }
  if (c.status === 'archived') throw Object.assign(new Error('Case is archived'), { code: 'CASE_NOT_ACTIVE' });
  const relatedDir = join(root, 'fixtures/qase/related');
  mkdirSync(relatedDir, { recursive: true });
  const related: QaseCase[] = [];
  for (const rid of linkedCaseIds(c)) {
    try {
      const r = caseCatalog.get(project, rid);
      if (r.status !== 'archived') related.push(r);
      continue;
    } catch (e) {
      if ((e as any).code !== 'NOT_FOUND') throw e;
    }
    // Locally authored cases never require a Qase account, including their prerequisites.
    if (c.source.kind !== 'qase') continue;
    const path = join(relatedDir, `${project}-${rid}.json`);
    if (!existsSync(path)) writeFileSync(path, JSON.stringify((await fetchCases(project, [rid]))[0], null, 2));
    related.push(JSON.parse(readFileSync(path, 'utf8')));
  }
  return { testCase: c, related };
};

export const summarizeRelated = (related: QaseCase[]) =>
  related
    .map((r) => {
      const steps = r.steps
        .slice(0, 3)
        .map(
          (s) =>
            `    ${s.position}. ${(s.action ?? '').replace(/\s+/g, ' ').trim()} → ${(s.expected_result ?? '').replace(/\s+/g, ' ').trim()}`,
        )
        .join('\n');
      return `- ${r.project}-${r.id} "${r.title}"\n${steps}`;
    })
    .join('\n');
