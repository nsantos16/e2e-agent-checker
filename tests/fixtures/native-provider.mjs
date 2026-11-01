#!/usr/bin/env node
// Disposable native protocol peer. Never reads a real credential directory.
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('fixture 2.1.316');
  process.exit(0);
}
const dir = process.env.E2E_FAKE_KIND === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
if (!dir || !dir.includes('checker-provider-')) throw new Error('Expected isolated fake profile');
const p = JSON.parse(readFileSync(dir + '/profile.json', 'utf8'));
const log = (event) =>
  appendFileSync(
    dir + '/events.jsonl',
    JSON.stringify({
      ...event,
      pid: process.pid,
      home: process.env.HOME,
      profile: dir,
      apiKeyPresent: !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY),
      args,
    }) + '\n',
  );
const send = (value) => console.log(JSON.stringify(value));
log({ action: 'start' });
if (args.includes('auth')) {
  if (p.error) {
    console.error(p.error);
    process.exit(1);
  }
  send({
    loggedIn: p.auth !== 'logged-out',
    authMethod: p.auth === 'api-key' ? 'api_key' : 'claude.ai',
    email: p.email,
    subscriptionType: 'fixture',
    accessToken: 'must-not-escape',
  });
} else if (args.includes('app-server')) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    log({ action: m.method ?? 'reply', params: m.params, error: m.error });
    if (m.method === 'initialize') return send({ id: m.id, result: {} });
    if (m.method === 'account/read')
      return send(
        p.error
          ? { id: m.id, error: { message: p.error } }
          : {
              id: m.id,
              result: {
                account:
                  p.auth === 'logged-out'
                    ? null
                    : {
                        type: p.auth === 'api-key' ? 'apiKey' : 'chatgpt',
                        email: p.email,
                        planType: 'fixture',
                        refreshToken: 'must-not-escape',
                      },
              },
            },
      );
    if (m.method === 'model/list')
      return send({
        id: m.id,
        result: {
          data: p.models.map((model) => ({ model, displayName: model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] })),
          nextCursor: null,
        },
      });
    if (m.method === 'account/rateLimits/read')
      return send({ id: m.id, result: { rateLimits: { primary: { usedPercent: p.exhausted ? 100 : 10, resetsAt: 4102444800 } } } });
    if (m.method === 'config/read')
      return send({ id: m.id, result: { config: { mcp_servers: { untrusted: { command: 'must-not-start' } } } } });
    if (m.method === 'thread/start') return send({ id: m.id, result: { thread: { id: p.email }, model: p.substitute ?? m.params.model } });
    if (m.method === 'turn/interrupt') return send({ id: m.id, result: {} });
    if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'turn-1' } } });
      send({
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { total: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 0 } } },
      });
      // A forbidden native tool request must be denied by the harness.
      send({ id: 999, method: 'item/commandExecution/requestApproval', params: {} });
    }
    if (m.id === 999 && m.error && !p.hang) {
      send({ method: 'item/completed', params: { item: { id: 'message', type: 'agentMessage', text: p.email } } });
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
  });
} else {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    if (args.includes('--input-format')) {
      log({ action: 'catalog', input });
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'catalog',
          response: { models: p.models.map((value) => ({ value, displayName: value, supportedEffortLevels: ['low', 'high'] })) },
        },
      });
      return;
    }
    log({ action: 'run', input });
    send({
      type: 'assistant',
      message: {
        id: 'm1',
        model: p.models[0],
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [],
      },
    });
    if (p.hang) return setInterval(() => {}, 1000);
    if (p.exhausted) return send({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 4102444800 } });
    if (p.runError) return send({ type: 'result', is_error: true, errors: [p.runError] });
    send({
      type: 'result',
      result: p.email,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  });
}
