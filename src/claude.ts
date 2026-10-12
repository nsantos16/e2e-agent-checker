import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Runs `claude -p` headless and returns the stream-json events, the final result, and cost/turn metrics.
// Child agents run in --restricted mode with dontAsk: user/project settings (including a bypass default) are ignored,
// only the built-in tools named in `tools` exist, file tools are confined to cwd + addDirs, and anything not in
// `allowedTools` is denied instead of prompting.

export type ClaudeRun = {
  prompt: string;
  cwd: string;
  model: string;
  tools: string[];
  allowedTools: string[];
  addDirs?: string[];
  mcpConfigPath?: string;
  transcriptPath: string;
  log?: (line: string) => void;
};

type ToolUse = { type: 'tool_use'; name: string; input: unknown };
type ResultEvent = {
  type: 'result';
  result: string;
  total_cost_usd: number;
  num_turns: number;
  usage: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
};

export type ClaudeOutcome = {
  exitCode: number;
  resultText: string;
  events: Record<string, unknown>[];
  metrics: { costUsd: number; turns: number; toolCalls: number; wallMs: number; models: string[]; usage?: Record<string, unknown> };
};

export const runClaude = async (run: ClaudeRun): Promise<ClaudeOutcome> => {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', run.model,
    '--restricted',
    '--permission-mode', 'dontAsk',
    '--tools', run.tools.join(','),
    '--allowedTools', run.allowedTools.join(','),
    ...(run.addDirs ?? []).flatMap((d) => ['--add-dir', d]),
    ...(run.mcpConfigPath ? ['--mcp-config', run.mcpConfigPath] : []),
    '--strict-mcp-config',
  ];
  const started = Date.now();
  const child = spawn('claude', args, { cwd: run.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(run.prompt);

  const events: Record<string, unknown>[] = [];
  let stderr = '';
  let buf = '';
  child.stderr.on('data', (d) => (stderr += d));
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
        for (const part of event.message.content as ToolUse[]) {
          if (part.type === 'tool_use') run.log?.(`→ ${part.name.replace(/^mcp__playwright__/, '')} ${JSON.stringify(part.input).slice(0, 100)}`);
        }
      }
    }
  });
  const exitCode: number = await new Promise((resolve) => child.on('close', resolve));
  writeFileSync(run.transcriptPath, events.map((e) => JSON.stringify(e)).join('\n'));

  const result = events.find((e): e is ResultEvent => e.type === 'result');
  if (!result) throw new Error(`claude exited ${exitCode} without a result. stderr: ${stderr.slice(-500)}`);
  const toolCalls = events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (e as { message: { content: { type: string }[] } }).message.content)
    .filter((p) => p.type === 'tool_use').length;
  return {
    exitCode,
    resultText: result.result,
    events,
    metrics: {
      costUsd: result.total_cost_usd,
      turns: result.num_turns,
      toolCalls,
      wallMs: Date.now() - started,
      models: Object.keys(result.modelUsage ?? {}),
      usage: result.usage,
    },
  };
};

export const lastJsonObject = <T>(text: string): T | undefined => {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const candidate of [...fenced.reverse(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next candidate
    }
  }
  return undefined;
};
