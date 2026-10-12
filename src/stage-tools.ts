import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolService } from './providers/codex.ts';
import { command } from './process.ts';
import { createHash } from 'node:crypto';
import { readTestResult } from './test-results.ts';

const root = new URL('..', import.meta.url).pathname;
export type StageConfig = {
  browserConfig?: string;
  actionsPath?: string;
  readFiles?: string[];
  specPath?: string;
  runDir?: string;
  maxAttempts?: number;
};
const serial = (fn: ToolService['call']): ToolService['call'] => {
  let pending: Promise<unknown> = Promise.resolve();
  return (name, args) => {
    const next = pending.then(() => fn(name, args));
    pending = next.catch(() => {});
    return next;
  };
};
const text = (value: string, isError = false) => ({ content: [{ type: 'text', text: value }], isError });
export async function stageTools(config: StageConfig, signal?: AbortSignal): Promise<ToolService> {
  if (config.browserConfig) {
    const client = new Client({ name: 'e2e-browser-recorder', version: '0.3.0' });
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.83', '--config', config.browserConfig],
      stderr: 'ignore',
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    return {
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema })),
      close: () => client.close(),
      call: serial(async (name, args) => {
        signal?.throwIfAborted();
        const r = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 });
        for (const c of r.content as any[])
          if (c.type === 'text') {
            const match = c.text.match(/### Ran Playwright code\s*```(?:js|ts)?\n([\s\S]*?)```/);
            if (match && config.actionsPath) appendFileSync(config.actionsPath, match[1].trim() + '\n');
          }
        return r;
      }),
    };
  }
  let attempts = 0;
  const files = new Set((config.readFiles ?? []).filter(existsSync).map((p) => realpathSync(p)));
  const spec = resolve(config.specPath!);
  const specParent = realpathSync(dirname(spec));
  const tools = [
    {
      name: 'read_input',
      description: 'Read an allowed QA input file or the generated spec by absolute path.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    },
    {
      name: 'write_spec',
      description: 'Replace the single generated Playwright spec with the provided source.',
      inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'], additionalProperties: false },
    },
    {
      name: 'try_spec',
      description: 'Run the generated spec against the selected build. Returns test output. Limited attempts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  return {
    tools,
    close: async () => {},
    call: serial(async (name, args) => {
      signal?.throwIfAborted();
      try {
        if (name === 'read_input') {
          const path = realpathSync(String(args.path));
          if (!files.has(path) && path !== spec) throw new Error('Path is not an allowed input');
          return text(readFileSync(path, 'utf8').slice(0, 100_000));
        }
        if (name === 'write_spec') {
          if (typeof args.source !== 'string' || args.source.length > 200_000) throw new Error('Invalid spec source');
          if (realpathSync(dirname(spec)) !== specParent || (existsSync(spec) && realpathSync(spec) !== spec))
            throw new Error('Spec path changed');
          writeFileSync(spec, args.source);
          return text('Spec saved');
        }
        if (name === 'try_spec') {
          if (++attempts > (config.maxAttempts ?? 8)) throw new Error('BUDGET_EXCEEDED: no more stabilization attempts');
          writeFileSync(join(config.runDir!, 'codify/attempts.json'), JSON.stringify({ attempts }));
          const specHash = createHash('sha256').update(readFileSync(spec)).digest('hex');
          const r = await command('sh', [join(root, 'scripts/try-spec.sh'), config.runDir!], { cwd: root, signal });
          const attemptsDir = join(config.runDir!, 'codify/attempts');
          const latest = readdirSync(attemptsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => join(attemptsDir, e.name))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
          writeFileSync(
            join(config.runDir!, 'codify/last-attempt.json'),
            JSON.stringify({ attempts, code: r.code, specHash, result: latest ? readTestResult(latest) : null }),
          );
          return text(`Attempt ${attempts}; exit ${r.code}\n${r.stdout.slice(-14000)}\n${r.stderr.slice(-1000)}`);
        }
        throw new Error('Tool not permitted');
      } catch (e) {
        signal?.throwIfAborted();
        return text(String(e), true);
      }
    }),
  };
}
