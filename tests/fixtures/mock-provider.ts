#!/usr/bin/env node
// Deterministic Codex protocol peer. Reads source only via the harness tool;
// deliberately exercises rejected assertion weakening after a failing attempt.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveFixtureSuite } from './mock-backend.ts';
const dir = process.env.MOCK_PROVIDER_DIR!;
if (process.argv.includes('--version')) {
  console.log('mock-provider 1.0.0');
  process.exit(0);
}
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
let phase = 0,
  sources: any,
  suite: any,
  prompt = '';
const call = (tool: string, args: unknown) =>
  send({
    id: 'tool-' + phase,
    method: 'item/tool/call',
    params: { tool, arguments: args },
  });
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method) {
    if (m.id === undefined) return;
    let result: any = {};
    if (m.method === 'account/read')
      result = {
        account: {
          type: 'chatgpt',
          email: 'mock@example.invalid',
          planType: 'fixture',
        },
      };
    if (m.method === 'model/list')
      result = {
        data: [
          {
            model: 'fixture',
            displayName: 'Fixture',
            supportedReasoningEfforts: [{ reasoningEffort: 'max' }],
          },
        ],
        nextCursor: null,
      };
    if (m.method === 'config/read') result = { config: { mcp_servers: {} } };
    if (m.method === 'thread/start') result = { thread: { id: 'mock-thread' }, model: m.params.model };
    if (m.method === 'turn/start') {
      result = { turn: { id: 'mock-turn' } };
      prompt = m.params.input?.map((i: any) => i.text ?? '').join('') ?? '';
    }
    send({ id: m.id, result });
    if (m.method === 'turn/start') {
      appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ event: 'model-turn', prompt }) + '\n');
      send({ method: 'turn/started', params: { turn: { id: 'mock-turn' } } });
      const paths = prompt.match(/Read (.*?) and (.*?) with read_inputs/)!.slice(1);
      phase = 1;
      call('read_inputs', { paths });
    }
    return;
  }
  appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ event: 'tool-result', phase, result: m.result }) + '\n');
  if (phase === 1) {
    const result = JSON.parse(m.result.contentItems[0].text);
    sources = JSON.parse(result.inputs[1].text);
    suite = deriveFixtureSuite(sources);
    phase = 2;
    call('write_mock_suite', { suite });
  } else if (phase === 2) {
    phase = 3;
    call('try_spec', {});
  } else if (phase === 3) {
    const weaker = structuredClone(suite);
    weaker.scenarios[1].steps[0].operations[1].value = 'Broken permission view';
    phase = 4;
    call('write_mock_suite', { suite: weaker });
  } else {
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cachedInputTokens: 0,
          },
        },
      },
    });
    send({
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: 'final',
          text: 'Fixture suite generated from supplied backend sources. Permission assertion remains failed.',
        },
      },
    });
    send({
      method: 'turn/completed',
      params: { turn: { id: 'mock-turn', status: 'completed' } },
    });
  }
});
