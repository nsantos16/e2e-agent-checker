import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read-only access to Qase through the self-run Qase MCP server (~/.local/bin/qase-mcp reads its token from the Keychain).

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
  const child = spawn(join(homedir(), '.local/bin/qase-mcp'), [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map<number, (m: { result?: { content: { text: string }[] }; error?: unknown }) => void>();
  let buf = '';
  let nextId = 0;
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        const m = JSON.parse(line);
        pending.get(m.id)?.(m);
      }
    }
  });
  const rpc = (method: string, params: object) =>
    new Promise<{ result?: { content: { text: string }[] }; error?: unknown }>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-agent-checker', version: '0.0.1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return await fn(async (tool, args) => {
      const r = await rpc('tools/call', { name: tool, arguments: args });
      if (r.error || !r.result) throw new Error(`Qase ${tool} failed: ${JSON.stringify(r.error)}`);
      return r.result.content.map((c) => c.text).join('\n');
    });
  } finally {
    child.kill();
  }
};

const FIELDS = ['id', 'title', 'priority', 'severity', 'steps', 'preconditions', 'description'];

const toCase = (project: string, raw: string): QaseCase => {
  const c = JSON.parse(raw);
  return {
    project,
    id: c.id,
    url: `https://app.qase.io/case/${project}-${c.id}`,
    title: c.title,
    priority: c.priority,
    severity: c.severity,
    preconditions: c.preconditions ?? null,
    description: c.description ?? null,
    steps: (c.steps ?? []).map((s: QaseStep) => ({ position: s.position, action: s.action, expected_result: s.expected_result, data: s.data ?? null })),
  };
};

export const fetchCases = (project: string, ids: number[]) =>
  withQaseMcp(async (call) => {
    const out: QaseCase[] = [];
    for (const id of ids) out.push(toCase(project, await call('qase_get', { entity: 'case', code: project, id, fields: FIELDS })));
    return out;
  });

export const linkedCaseIds = (c: QaseCase) => {
  const text = `${c.preconditions ?? ''}\n${c.description ?? ''}\n${c.steps.map((s) => `${s.action}\n${s.expected_result}`).join('\n')}`;
  return [...new Set([...text.matchAll(new RegExp(`${c.project}-(\\d+)`, 'g'))].map((m) => Number(m[1])))].filter((id) => id !== c.id);
};

// The case plus a short summary of every Qase case its text links to (they usually describe how to reach a page).
export const loadCaseWithRelated = async (project: string, id: number) => {
  const path = fixturePath(project, id);
  const c: QaseCase = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : (await fetchCases(project, [id]))[0];
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(c, null, 2));

  const relatedDir = join(root, 'fixtures/qase/related');
  mkdirSync(relatedDir, { recursive: true });
  const ids = linkedCaseIds(c);
  const missing = ids.filter((rid) => !existsSync(join(relatedDir, `${project}-${rid}.json`)));
  if (missing.length) {
    for (const r of await fetchCases(project, missing)) writeFileSync(join(relatedDir, `${project}-${r.id}.json`), JSON.stringify(r, null, 2));
  }
  const related = ids.map((rid) => JSON.parse(readFileSync(join(relatedDir, `${project}-${rid}.json`), 'utf8')) as QaseCase);
  return { testCase: c, related };
};

export const summarizeRelated = (related: QaseCase[]) =>
  related
    .map((r) => {
      const steps = r.steps
        .slice(0, 3)
        .map((s) => `    ${s.position}. ${(s.action ?? '').replace(/\s+/g, ' ').trim()} → ${(s.expected_result ?? '').replace(/\s+/g, ' ').trim()}`)
        .join('\n');
      return `- ${r.project}-${r.id} "${r.title}"\n${steps}`;
    })
    .join('\n');
