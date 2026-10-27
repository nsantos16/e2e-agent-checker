import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.STAGE_FIXTURE_DIR!;
const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
const results: unknown[] = [];
let next = 0,
  last: any;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const advance = () => {
  if (next === plan.length) {
    send({
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: 'final', text: '{"ok":true}' },
      },
    });
    send({
      method: 'turn/completed',
      params: { turn: { id: 'turn', status: 'completed' } },
    });
    return;
  }
  const call = structuredClone(plan[next++]);
  if (call.arguments.id === '$evidence') call.arguments.id = last.actions?.[0]?.evidenceId ?? last.inputs?.[0]?.evidenceId;
  send({ id: 'call-' + next, method: 'item/tool/call', params: call });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method) {
    if (m.id === undefined) return;
    let result: any = {};
    if (m.method === 'account/read') result = { account: { type: 'chatgpt' } };
    if (m.method === 'config/read') result = { config: { mcp_servers: { unrelated: { enabled: true } } } };
    if (m.method === 'thread/start') {
      writeFileSync(join(dir, 'thread.json'), JSON.stringify(m.params));
      result = { thread: { id: 'thread' } };
    }
    if (m.method === 'turn/start') result = { turn: { id: 'turn' } };
    send({ id: m.id, result });
    if (m.method === 'turn/start') {
      send({ method: 'turn/started', params: { turn: { id: 'turn' } } });
      advance();
    }
  } else {
    results.push(m);
    writeFileSync(join(dir, 'provider-results.json'), JSON.stringify(results));
    try {
      last = JSON.parse(m.result.contentItems[0].text);
    } catch {
      last = {};
    }
    advance();
  }
});
