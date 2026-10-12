import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { lastJsonObject, runClaude, type ClaudeOutcome } from './claude.ts';
import { statePath } from './login.ts';
import { loadCaseWithRelated, summarizeRelated, type QaseCase } from './qase.ts';

// Stage 1: an agent verifies a Qase case step by step in a live browser (Playwright MCP) and reports evidence.

export type StepVerdict = { position: number; verdict: 'pass' | 'fail' | 'blocked'; evidence: string; inferred?: boolean; check?: string };
export type ExploreReport = { caseId: number; verdict: 'pass' | 'fail' | 'blocked'; steps: StepVerdict[]; dataChanges?: string; notes?: string };

export type ExploreOptions = {
  project: string;
  caseId: number;
  base: string;
  role: string;
  slot: string;
  model: string;
  runDir: string;
  headed?: boolean;
  log?: (line: string) => void;
};

const root = new URL('..', import.meta.url).pathname;

const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';

// Every browser action Playwright MCP executed, as code, in order. The codify stage builds the spec from it.
export const actionLog = (events: ClaudeOutcome['events']) => {
  const code: string[] = [];
  for (const e of events) {
    if (e.type !== 'user') continue;
    for (const part of (e as { message: { content: unknown[] } }).message.content) {
      const p = part as { type?: string; content?: string | { text?: string }[] };
      if (p.type !== 'tool_result') continue;
      const text = typeof p.content === 'string' ? p.content : (p.content ?? []).map((c) => c.text ?? '').join('\n');
      const match = text.match(/### Ran Playwright code\s*```(?:js|ts)?\n([\s\S]*?)```/);
      const url = text.match(/- Page URL: (\S+)/)?.[1];
      if (match) code.push(`${match[1].trim()}${url ? `  // → ${url}` : ''}`);
    }
  }
  return code;
};

export const explore = async (opts: ExploreOptions) => {
  const state = statePath(opts.slot, opts.role);
  if (!existsSync(state)) throw new Error(`No session for slot ${opts.slot}/${opts.role}. Run: npm run login -- --slot ${opts.slot} --role ${opts.role} --base ${opts.base}`);
  const dir = join(opts.runDir, 'explore');
  mkdirSync(join(dir, 'video'), { recursive: true });

  const { testCase, related } = await loadCaseWithRelated(opts.project, opts.caseId);

  const mcpConfigPath = join(dir, 'playwright-mcp.config.json');
  writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        browser: {
          browserName: 'chromium',
          isolated: true,
          launchOptions: { headless: !opts.headed },
          contextOptions: {
            storageState: state,
            viewport: { width: 1440, height: 900 },
            recordVideo: { dir: join(dir, 'video'), size: { width: 1440, height: 900 } },
          },
        },
        outputDir: join(dir, 'mcp-output'),
        testIdAttribute: 'data-testid',
      },
      null,
      2,
    ),
  );
  const claudeMcpConfigPath = join(dir, 'claude-mcp.json');
  writeFileSync(claudeMcpConfigPath, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--config', mcpConfigPath] } } }));

  const runId = opts.runDir.split('/').pop()!;
  const prompt = readFileSync(join(root, 'prompts/verify-case.md'), 'utf8')
    .replaceAll('{{BASE_URL}}', opts.base)
    .replaceAll('{{CASE_JSON}}', JSON.stringify(testCase satisfies QaseCase, null, 2))
    .replaceAll('{{RELATED_CASES}}', related.length ? summarizeRelated(related) : '(none)')
    .replaceAll('{{APP_CONTEXT}}', readFileSync(join(root, 'context/sample-app.md'), 'utf8'))
    .replaceAll('{{CASE_ID}}', String(opts.caseId))
    .replaceAll('{{RUN_ID}}', runId);
  writeFileSync(join(dir, 'prompt.md'), prompt);

  const outcome = await runClaude({
    prompt,
    cwd: dir,
    model: opts.model,
    allowedTools: ['mcp__playwright'],
    disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep'],
    mcpConfigPath: claudeMcpConfigPath,
    transcriptPath: join(dir, 'transcript.jsonl'),
    log: opts.log,
  });

  const report = lastJsonObject<ExploreReport>(outcome.resultText);
  const actions = actionLog(outcome.events);
  writeFileSync(join(dir, 'report.json'), report ? JSON.stringify(report, null, 2) : outcome.resultText);
  writeFileSync(join(dir, 'actions.js'), actions.join('\n'));
  const metrics = { ...outcome.metrics, videos: readdirSync(join(dir, 'video')) };
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  return { testCase, report, actions, metrics };
};

export const newRunDir = (project: string, caseId: number, slot: string, label = '') => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const dir = join(root, 'runs', `${stamp}-${project}-${caseId}-slot${slot}${label ? `-${label}` : ''}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      case: { type: 'string' },
      project: { type: 'string', default: 'DEMO' },
      base: { type: 'string', default: 'http://localhost:4001' },
      role: { type: 'string', default: 'eugene' },
      slot: { type: 'string', default: '1' },
      model: { type: 'string', default: 'sonnet' },
      label: { type: 'string', default: '' },
      headed: { type: 'boolean', default: false },
    },
  });
  if (!values.case) throw new Error('Usage: node src/explore.ts --case <id>');
  const caseId = Number(values.case);
  const runDir = newRunDir(values.project!, caseId, values.slot!, values.label);
  console.log(`Explore ${values.project}-${caseId} → ${runDir}`);
  const { report, metrics } = await explore({ ...values, caseId, runDir, project: values.project!, base: values.base!, role: values.role!, slot: values.slot!, model: values.model!, log: (l) => console.log(`  ${l}`) });
  console.log(`\nVerdict: ${report?.verdict ?? 'unparsed'}`);
  for (const s of report?.steps ?? []) console.log(`  ${s.position}. ${s.verdict}${s.inferred ? ' (inferred)' : ''}: ${s.evidence.slice(0, 160)}`);
  console.log(`Cost $${metrics.costUsd.toFixed(3)} · ${metrics.turns} turns · ${metrics.toolCalls} tool calls · ${(metrics.wallMs / 1000).toFixed(0)}s`);
}
