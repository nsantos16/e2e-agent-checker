import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { statePath } from './login.ts';

// Iteration 1: verify one Qase case with Claude Code + Playwright MCP against one slot, and keep every artifact.

const { values } = parseArgs({
  options: {
    case: { type: 'string' },
    base: { type: 'string', default: 'http://localhost:4001' },
    role: { type: 'string', default: 'eugene' },
    slot: { type: 'string', default: '1' },
    model: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

const root = new URL('..', import.meta.url).pathname;
const casePath = join(root, 'fixtures/qase', `DEMO-${values.case}.json`);
if (!values.case || !existsSync(casePath)) throw new Error(`Usage: --case <id> (expects ${casePath})`);
const state = statePath(values.slot!, values.role!);
if (!existsSync(state)) throw new Error(`No session for slot ${values.slot}/${values.role}. Run: npm run login -- --slot ${values.slot} --role ${values.role}`);

const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-DEMO-${values.case}-slot${values.slot}`;
const runDir = join(root, 'runs', runId);
mkdirSync(join(runDir, 'video'), { recursive: true });

const mcpConfigPath = join(runDir, 'playwright-mcp.config.json');
writeFileSync(
  mcpConfigPath,
  JSON.stringify(
    {
      browser: {
        browserName: 'chromium',
        isolated: true,
        launchOptions: { headless: !values.headed },
        contextOptions: {
          storageState: state,
          viewport: { width: 1440, height: 900 },
          recordVideo: { dir: join(runDir, 'video'), size: { width: 1440, height: 900 } },
        },
      },
      outputDir: join(runDir, 'mcp-output'),
      testIdAttribute: 'data-testid',
    },
    null,
    2,
  ),
);
const claudeMcpConfigPath = join(runDir, 'claude-mcp.json');
writeFileSync(
  claudeMcpConfigPath,
  JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--config', mcpConfigPath] } },
  }),
);

const caseJson = readFileSync(casePath, 'utf8');
const prompt = readFileSync(join(root, 'prompts/verify-case.md'), 'utf8')
  .replaceAll('{{BASE_URL}}', values.base!)
  .replaceAll('{{CASE_JSON}}', caseJson.trim())
  .replaceAll('{{CASE_ID}}', values.case)
  .replaceAll('{{RUN_ID}}', runId);
writeFileSync(join(runDir, 'prompt.md'), prompt);

const args = [
  '-p',
  '--output-format', 'stream-json',
  '--verbose',
  '--mcp-config', claudeMcpConfigPath,
  '--strict-mcp-config',
  '--allowedTools', 'mcp__playwright',
  '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent,NotebookEdit',
  ...(values.model ? ['--model', values.model] : []),
];

console.log(`Run ${runId}\n  case: ${JSON.parse(caseJson).title}\n  dir:  runs/${runId}`);
const started = Date.now();
const child = spawn('claude', args, { cwd: runDir, stdio: ['pipe', 'pipe', 'inherit'] });
child.stdin.end(prompt);

const events: unknown[] = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === 'assistant') {
      for (const part of event.message.content) {
        if (part.type === 'tool_use') console.log(`  → ${part.name.replace('mcp__playwright__', '')} ${JSON.stringify(part.input).slice(0, 110)}`);
      }
    }
  }
});

const code: number = await new Promise((resolve) => child.on('close', resolve));
writeFileSync(join(runDir, 'transcript.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));

type ResultEvent = { type: 'result'; result: string; total_cost_usd: number; num_turns: number; duration_ms: number; usage: Record<string, number>; modelUsage?: Record<string, unknown> };
const result = events.find((e): e is ResultEvent => (e as ResultEvent).type === 'result');
const toolCalls = events
  .filter((e) => (e as { type: string }).type === 'assistant')
  .flatMap((e) => (e as { message: { content: { type: string }[] } }).message.content)
  .filter((p) => p.type === 'tool_use').length;

const metrics = {
  runId,
  caseId: Number(values.case),
  exitCode: code,
  wallMs: Date.now() - started,
  costUsd: result?.total_cost_usd,
  turns: result?.num_turns,
  toolCalls,
  usage: result?.usage,
  models: result?.modelUsage ? Object.keys(result.modelUsage) : undefined,
  videos: readdirSync(join(runDir, 'video')),
};
writeFileSync(join(runDir, 'metrics.json'), JSON.stringify(metrics, null, 2));

const json = result?.result.match(/\{[\s\S]*\}/)?.[0];
let report: { verdict?: string; steps?: { position: number; verdict: string; evidence: string; inferred?: boolean }[] } | undefined;
try {
  report = json ? JSON.parse(json) : undefined;
} catch {
  report = undefined;
}
writeFileSync(join(runDir, 'report.json'), report ? JSON.stringify(report, null, 2) : (result?.result ?? ''));

console.log(`\nVerdict: ${report?.verdict ?? 'unparsed (see report.json)'}`);
for (const s of report?.steps ?? []) console.log(`  ${s.position}. ${s.verdict}${s.inferred ? ' (inferred)' : ''}: ${s.evidence.slice(0, 140)}`);
console.log(`Cost $${metrics.costUsd?.toFixed(3)} · ${metrics.turns} turns · ${toolCalls} tool calls · ${(metrics.wallMs / 1000).toFixed(0)}s · video: ${metrics.videos.join(', ') || 'none'}`);
