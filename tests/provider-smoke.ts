// Explicit opt-in live test: consumes the selected native subscription's allowance.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { explore, newRunDir } from '../src/explore.ts';
import { codify } from '../src/codify.ts';
import { replay } from '../src/replay.ts';
import { statePath } from '../src/login.ts';
import { targetSchema } from '../src/providers/index.ts';
const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'codex' },
    model: { type: 'string', default: 'gpt-6.1-sol' },
    broken: { type: 'boolean', default: false },
  },
});
const root = new URL('..', import.meta.url).pathname;
const target = targetSchema.parse({ provider: values.provider, model: values.model, authMode: 'subscription' });
const fixture = join(root, 'fixtures/qase/SMOKE-999999.json'),
  state = statePath('999', 'smoke');
if (existsSync(fixture) || existsSync(state)) throw new Error('Smoke fixture already exists; another test may be running');
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(join(root, 'tests/fixtures/note.html'), 'utf8'));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port,
  base = `http://127.0.0.1:${port}`;
const testCase = {
  project: 'SMOKE',
  id: 999999,
  title: 'Multiline note round trip',
  url: '',
  preconditions:
    'This is a disposable local fixture. Navigate directly to /' +
    (values.broken ? '?broken' : '') +
    '. Ignore the Sample app context; there is no login or client page. The note can be safely cleared.',
  description: null,
  steps: [
    {
      position: 1,
      action: 'Navigate to /' + (values.broken ? '?broken' : '') + ' and fill Note with exactly e2e-agent-first, a newline, and second.',
      expected_result: 'Note contains exactly two lines: e2e-agent-first and second.',
      data: null,
    },
    {
      position: 2,
      action: 'Click Save, then Reopen.',
      expected_result: 'The status says Saved and Note still contains the same two lines separated by a newline.',
      data: null,
    },
    { position: 3, action: 'Click Clear.', expected_result: 'Note is empty and status says Cleared.', data: null },
  ],
};
writeFileSync(fixture, JSON.stringify(testCase));
writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
const runDir = newRunDir('SMOKE', 999999, '999', values.broken ? 'broken' : 'good');
const signal = AbortSignal.timeout(10 * 60_000);
const log = (s: string) => console.log(s);
try {
  const e = await explore({
    project: 'SMOKE',
    caseId: 999999,
    base,
    role: 'smoke',
    slot: '999',
    model: target.model,
    target,
    runDir,
    signal,
    log,
  });
  console.log('explore', e.report.verdict);
  const c = await codify({
    project: 'SMOKE',
    caseId: 999999,
    base,
    role: 'smoke',
    slot: '999',
    model: target.model,
    target,
    runDir,
    signal,
    maxAttempts: 2,
    log,
  });
  console.log('codify', c.result);
  const r = await replay({
    runDir,
    label: 'smoke',
    specDir: c.specDir,
    specFile: c.specFile,
    base,
    slot: '999',
    role: 'smoke',
    signal,
    slowMo: 0,
  });
  const expected = values.broken ? 'failed' : 'passed';
  const summary = {
    runDir,
    target,
    expected,
    explore: e.report.verdict,
    codify: c.result.outcome,
    replay: r.status,
    video: r.video,
    usage: { explore: e.metrics.usage, codify: c.metrics.usage },
  };
  writeFileSync(join(runDir, 'smoke-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (
    r.status !== expected ||
    e.report.verdict !== (values.broken ? 'fail' : 'pass') ||
    c.result.outcome !== (values.broken ? 'failed-as-expected' : 'passed')
  )
    process.exitCode = 1;
} finally {
  server.close();
  rmSync(fixture, { force: true });
  rmSync(state, { force: true });
}
