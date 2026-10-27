import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
  symlinkSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageTools } from '../src/stage-tools.ts';
import { browserTools } from '../src/stage-browser.ts';
import { StageEvidence, RESULT_BYTES, resultBytes } from '../src/stage-results.ts';

const fixture = new URL('./fixtures/stage-browser-mcp.ts', import.meta.url).pathname;
const parse = (r: any) => JSON.parse(r.content[0].text);
async function browser() {
  const dir = mkdtempSync(join(tmpdir(), 'stage-batch-'));
  const oldPath = process.env.PATH,
    oldFixture = process.env.STAGE_FIXTURE_DIR;
  writeFileSync(join(dir, 'npx'), `#!/usr/bin/env node\nimport(${JSON.stringify(fixture)});`, { mode: 0o755 });
  mkdirSync(join(dir, 'output'));
  const config = join(dir, 'browser.json');
  writeFileSync(
    config,
    JSON.stringify({
      outputDir: join(dir, 'output'),
      secrets: { PASSWORD: 'fixture-password' },
    }),
  );
  process.env.PATH = dir + ':' + oldPath;
  process.env.STAGE_FIXTURE_DIR = dir;
  const service = await stageTools({
    browserConfig: config,
    actionsPath: join(dir, 'explore/actions.js'),
    runDir: dir,
  });
  return {
    dir,
    service,
    async close() {
      await service.close();
      process.env.PATH = oldPath;
      if (oldFixture === undefined) delete process.env.STAGE_FIXTURE_DIR;
      else process.env.STAGE_FIXTURE_DIR = oldFixture;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const dispatches = (dir: string) =>
  existsSync(join(dir, 'dispatch.jsonl'))
    ? readFileSync(join(dir, 'dispatch.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s).target)
    : [];
const audit = (dir: string) =>
  readFileSync(join(dir, 'explore/actions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
test('elapsed deadlines stop dispatch even before an abort timer can run', async (t) => {
  let now = 0,
    calls = 0,
    closed = false;
  t.mock.method(Date, 'now', () => now);
  const service = browserTools(
    {
      tools: [{ name: 'browser_click', description: 'fixture', inputSchema: { type: 'object' } }],
      call: async () => {
        calls++;
        now = 120_001;
        return { content: [{ type: 'text', text: '### Result\ntrue' }] };
      },
      close: async () => {
        closed = true;
      },
    },
    new StageEvidence(),
    {},
  );
  const result = parse(await service.call('browser_click', { target: 'first' }));
  assert.equal(calls, 1);
  assert(closed);
  assert.equal(result.actions[0].status, 'uncertain');
  assert.deepEqual(result.unexecuted, []);
  assert.equal((await service.call('browser_click', { target: 'never' })).isError, true);
  assert.equal(calls, 1);
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(check());
}

test('browser calls own the stage lock, preserve order, all code blocks and bounded locator evidence', async () => {
  const f = await browser();
  try {
    const [first, multi, raw, other] = await Promise.all([
      f.service.call('browser_click', { target: 'first' }),
      f.service.call('browser_click', { target: 'multi' }),
      f.service.call('browser_click', { target: 'snapshot-file' }),
      f.service.call('browser_click', { target: 'after' }),
    ]);
    assert([first, multi, raw, other].every((r) => !r.isError && resultBytes(r) <= RESULT_BYTES));
    assert.deepEqual(dispatches(f.dir), ['first', 'multi', 'snapshot-file', 'after']);
    const result = parse(raw);
    assert.deepEqual(result.completed, [1]);
    assert.deepEqual(result.unexecuted, []);
    assert.equal(other.isError, false);
    assert(resultBytes(raw) <= RESULT_BYTES);
    assert.match(result.state.Snapshot.text, /Item 0.*\[ref=e0\]/);
    assert.equal(result.state.Snapshot.truncated, true);
    const source = readFileSync(join(f.dir, 'explore/actions.js'), 'utf8');
    assert(source.indexOf("name: 'first'") < source.indexOf("name: 'multi'"));
    assert.match(source, /getByLabel\('Second'\)/);
    assert.match(source, /fill\('a ``` fence'\);/);
    assert.equal(audit(f.dir).filter((r) => r.status === 'started').length, 4);
    assert.equal(audit(f.dir).filter((r) => r.status === 'completed' && r.id).length, 4);
    let text = '',
      offset: number | null = 0,
      pages = 0;
    while (offset !== null) {
      const page = await f.service.call('qa_tool_result', {
        id: result.actions[0].evidenceId,
        offset,
        limit: 2000,
      });
      assert(resultBytes(page) <= RESULT_BYTES);
      const data = parse(page);
      text += data.text;
      offset = data.nextOffset;
      pages++;
    }
    assert(pages > 1);
    assert.match(text, /Item 1499.*ref=e1499/);
    assert(!text.includes('fixture-password'));
    assert(!JSON.stringify(raw).includes('token=private'));
    assert(JSON.parse(text).response.content.some((c: any) => c.text.includes('Item 1499')));
    const saved = join(f.dir, 'tool-results', result.actions[0].evidenceId + '.json');
    assert.equal(statSync(saved).mode & 0o777, 0o600);
    const reloaded = new StageEvidence(f.dir);
    assert.match(parse(reloaded.read({ id: result.actions[0].evidenceId })).text, /browser_click/);
  } finally {
    await f.close();
  }
});

test('native assertion outcomes and modal state remain useful without a generic batch tool', async () => {
  const f = await browser();
  try {
    const passed = parse(await f.service.call('browser_verify_text', { target: 'ok' }));
    assert.equal(passed.actions[0].assertion, 'passed');
    const failed = await f.service.call('browser_verify_text', { target: 'reject' });
    assert.equal(failed.isError, true);
    assert.equal(parse(failed).actions[0].status, 'failed');
    assert.equal(parse(failed).actions[0].assertion, 'failed');
    assert.match(parse(failed).actions[0].error, /Permission rejected/);
    assert.deepEqual(parse(failed).completed, []);
    const modal = parse(await f.service.call('browser_click', { target: 'modal' }));
    assert.match(modal.state['Modal state'].text, /confirmation dialog/);
    assert.deepEqual(dispatches(f.dir), ['ok', 'reject', 'modal']);
    assert(!f.service.tools.some((t) => t.name === 'browser_batch'));
  } finally {
    await f.close();
  }
});

test('browser validation rejects unavailable tools, malformed arguments and oversized calls before dispatch', async () => {
  const f = await browser();
  try {
    for (const [name, args] of [
      ['shell', {}],
      ['read_input', {}],
      ['browser_batch', { actions: [] }],
      ['browser_click', {}],
      ['browser_click', { target: 'x', extra: true }],
      ['browser_click', { target: 'x'.repeat(70_000) }],
      ['browser_click', null],
      ['browser_click', []],
      ['x'.repeat(70_000), {}],
    ] as const) {
      const result = await f.service.call(name, args);
      assert.equal(result.isError, true);
      assert(resultBytes(result) <= RESULT_BYTES);
      assert.deepEqual(parse(result).completed, []);
    }
    assert.deepEqual(dispatches(f.dir), []);
    assert(!f.service.tools.some((t) => ['browser_batch', 'read_input', 'read_inputs', 'write_spec', 'try_spec'].includes(t.name)));
  } finally {
    await f.close();
  }
});

for (const mode of ['cancel', 'timeout', 'throw', 'timeout-result', 'close'] as const)
  test(`${mode} records uncertain work, never retries and prevents queued mutation`, async () => {
    const f = await browser();
    const controller = new AbortController();
    try {
      const done = await f.service.call('browser_click', { target: 'done' });
      assert.equal(done.isError, false);
      const task = f.service.call(
        'browser_click',
        { target: mode === 'throw' || mode === 'timeout-result' ? mode : 'slow' },
        mode === 'timeout' ? AbortSignal.timeout(200) : controller.signal,
      );
      const queued = f.service.call('browser_click', { target: 'queued' });
      if (mode === 'cancel' || mode === 'close') {
        await until(() => existsSync(join(f.dir, 'started')));
        if (mode === 'cancel') controller.abort(new Error('cancel batch'));
        else await f.service.close();
      }
      const result = parse(await task);
      assert.deepEqual(result.completed, []);
      assert.deepEqual(result.unexecuted, []);
      assert.equal(result.actions[0].status, 'uncertain');
      assert.equal((await queued).isError, true);
      assert.deepEqual(dispatches(f.dir), ['done', mode === 'throw' || mode === 'timeout-result' ? mode : 'slow']);
      const failed = audit(f.dir).find((r) => r.id && r.status === 'uncertain');
      assert(failed);
      assert(audit(f.dir).some((r) => r.id && r.status === 'completed'));
      assert(audit(f.dir).some((r) => r.kind === 'batch' && r.unexecuted.length === 1));
    } finally {
      await f.close();
    }
  });

test('pre-cancelled browser calls dispatch nothing', async () => {
  const f = await browser();
  try {
    const result = parse(await f.service.call('browser_click', { target: 'never' }, AbortSignal.abort()));
    assert.deepEqual(result.unexecuted, [1]);
    assert.deepEqual(dispatches(f.dir), []);
  } finally {
    await f.close();
  }
});

test('cancellation while waiting for the lock leaves the request unexecuted and preserves the active call', async () => {
  const f = await browser(),
    controller = new AbortController();
  try {
    const active = f.service.call('browser_click', { target: 'delayed' });
    const queued = f.service.call('browser_click', { target: 'never' }, controller.signal);
    controller.abort();
    assert.equal((await active).isError, false);
    assert.deepEqual(parse(await queued).unexecuted, [1]);
    assert.equal((await f.service.call('browser_click', { target: 'after' })).isError, false);
    assert.deepEqual(dispatches(f.dir), ['delayed', 'after']);
  } finally {
    await f.close();
  }
});

test('screenshot evidence is retrievable without a new browser action and image responses are bounded', async () => {
  const f = await browser();
  try {
    const first = parse(await f.service.call('browser_click', { target: 'image' }));
    const second = parse(await f.service.call('browser_click', { target: 'large-image' }));
    assert.equal(first.actions[0].imageCount, 1);
    const small = await f.service.call('qa_tool_result', {
      id: first.actions[0].evidenceId,
      imageIndex: 0,
    });
    assert.equal(small.isError, false);
    assert.equal(small.content[0].type, 'image');
    assert(resultBytes(small) < 1_048_576);
    const large = await f.service.call('qa_tool_result', {
      id: second.actions[0].evidenceId,
      imageIndex: 0,
    });
    assert.equal(large.isError, true);
    assert(resultBytes(large) < RESULT_BYTES);
    assert.deepEqual(dispatches(f.dir), ['image', 'large-image']);
  } finally {
    await f.close();
  }
});

test('snapshot file expansion does not read outside the configured driver output directory', async () => {
  const f = await browser();
  try {
    for (const target of ['snapshot-outside', 'snapshot-outside-symlink']) {
      const result = parse(await f.service.call('browser_click', { target }));
      const detail = readFileSync(join(f.dir, 'tool-results', result.actions[0].evidenceId + '.json'), 'utf8');
      assert(!detail.includes('DO-NOT-READ-OUTSIDE-OUTPUT'));
    }
  } finally {
    await f.close();
  }
});

test('grouped input reads preserve order, exclude writes, retain full details and enforce file boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-inputs-'));
  const input = join(dir, 'input'),
    spec = join(dir, 'case.spec.ts'),
    secret = join(dir, 'secret');
  writeFileSync(input, 'A'.repeat(150000) + '\nEND-OF-INPUT');
  writeFileSync(spec, 'old spec');
  writeFileSync(secret, 'not permitted');
  const service = await stageTools({
    readFiles: [input],
    specPath: spec,
    runDir: dir,
  });
  try {
    const [result] = await Promise.all([
      service.call('read_inputs', { paths: [input, spec] }),
      service.call('write_spec', { source: 'new spec' }),
    ]);
    assert(resultBytes(result) <= RESULT_BYTES);
    const { inputs } = parse(result);
    assert.deepEqual(
      inputs.map((i: any) => i.path),
      [input, spec].map((p) => realpathSync(p)),
    );
    assert.equal(inputs[1].text, 'old spec');
    assert.equal(inputs[0].truncated, true);
    assert.equal(readFileSync(spec, 'utf8'), 'new spec');
    assert.match(readFileSync(join(dir, 'tool-results', inputs[0].evidenceId + '.json'), 'utf8'), /END-OF-INPUT/);
    assert.equal((await service.call('read_inputs', { paths: [input, secret] })).isError, true);
    assert.equal((await service.call('read_inputs', { paths: Array(9).fill(input) })).isError, true);
    assert.equal((await service.call('browser_batch', { actions: [] })).isError, true);
    assert(!service.tools.some((t) => t.name.startsWith('browser_')));
    rmSync(spec);
    symlinkSync(secret, spec);
    assert.equal((await service.call('read_inputs', { paths: [spec] })).isError, true);
    assert.equal((await service.call('qa_tool_result', { id: '../secret' })).isError, true);
    assert.equal(
      (
        await service.call('qa_tool_result', {
          id: inputs[0].evidenceId,
          limit: 8001,
        })
      ).isError,
      true,
    );
    const saved = join(dir, 'tool-results', inputs[0].evidenceId + '.json');
    rmSync(saved);
    symlinkSync(secret, saved);
    assert.equal((await service.call('qa_tool_result', { id: inputs[0].evidenceId })).isError, true);
    assert.equal((await service.call('read_inputs', { paths: [input] }, AbortSignal.abort())).isError, true);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing spec or forbidden input does not discard independent successful reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-partial-'));
  const paths = ['case', 'helper', 'outside', 'spec.ts'].map((p) => join(dir, p));
  writeFileSync(paths[0], 'complete case');
  writeFileSync(paths[1], 'complete helper');
  writeFileSync(paths[2], 'PRIVATE-OUTSIDE-CONTENT');
  const service = await stageTools({ readFiles: paths.slice(0, 2), specPath: paths[3], runDir: dir });
  try {
    assert.match(service.tools.find((t) => t.name === 'read_inputs')!.description, /does not exist at stage start/);
    const raw = await service.call('read_inputs', { paths: [paths[0], paths[3], paths[1], paths[2]] });
    assert.equal(raw.isError, true);
    const { inputs } = parse(raw);
    assert.equal(inputs[0].text, 'complete case');
    assert.match(inputs[1].error, /ENOENT/);
    assert.equal(inputs[2].text, 'complete helper');
    assert.match(inputs[3].error, /not an allowed input/);
    assert(!JSON.stringify(raw).includes('PRIVATE-OUTSIDE-CONTENT'));
    assert.equal(inputs[0].truncated, false);
    assert.equal(inputs[2].nextOffset, null);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grouped reads use spare response space and detail cursors return only remaining original text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-budget-'));
  const paths = Array.from({ length: 6 }, (_, i) => join(dir, `input-${i}`));
  const texts = [100, 200, 500, 1000, 4500, 5500].map((size, i) => `${i}:` + 'x'.repeat(size));
  paths.forEach((path, i) => writeFileSync(path, texts[i]));
  const service = await stageTools({ readFiles: paths, specPath: join(dir, 'spec.ts'), runDir: dir });
  try {
    const complete = await service.call('read_inputs', { paths });
    assert(resultBytes(complete) <= RESULT_BYTES);
    assert.deepEqual(
      parse(complete).inputs.map((entry: any) => entry.text),
      texts,
    );
    assert(parse(complete).inputs.every((entry: any) => !entry.truncated && entry.nextOffset === null));

    const long = 'line "quoted" \\ path 🦉\n'.repeat(4000) + 'END';
    writeFileSync(paths[5], long);
    const bounded = await service.call('read_inputs', { paths });
    assert(resultBytes(bounded) <= RESULT_BYTES);
    const entries = parse(bounded).inputs;
    assert.equal(entries[4].text, texts[4], 'small files finish before a large file consumes the remainder');
    let reconstructed = entries[5].text,
      offset: number | null = entries[5].nextOffset;
    assert.equal(offset, reconstructed.length);
    assert(offset! > 1800, 'the large file receives unused space instead of an equal fixed slice');
    const restarted = new StageEvidence(dir);
    while (offset !== null) {
      const reply = restarted.read({ id: entries[5].evidenceId, offset });
      assert(resultBytes(reply) <= RESULT_BYTES);
      const page = parse(reply);
      assert.equal(page.format, 'text');
      assert.equal(page.offset, offset);
      assert.equal(page.text, long.slice(offset, offset + page.text.length));
      assert(page.text.length <= 8000);
      reconstructed += page.text;
      offset = page.nextOffset;
    }
    assert.equal(reconstructed, long);

    const single = parse(await service.call('read_input', { path: paths[5] }));
    assert.equal(single.nextOffset, single.text.length);
    const remainder = parse(await service.call('qa_tool_result', { id: single.evidenceId, offset: single.nextOffset }));
    assert.equal(remainder.text, long.slice(single.nextOffset, single.nextOffset + remainder.text.length));
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the source view keeps code once while full submitted arguments and outcomes remain in the audit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-source-'));
  const code = "await page.getByLabel('Name').fill('value');\n" + '// recorded source\n'.repeat(150);
  const args = { code, locator: 'Name', input: 'value' };
  const service = browserTools(
    {
      tools: [{ name: 'browser_run_code_unsafe', description: 'fixture', inputSchema: { type: 'object' } }],
      call: async () => ({ content: [{ type: 'text', text: '### Ran Playwright code\n```js\n' + code + '```\n### Result\ntrue' }] }),
      close: async () => {},
    },
    new StageEvidence(dir),
    { runDir: dir, actionsPath: join(dir, 'explore/actions.js') },
  );
  try {
    const result = parse(await service.call('browser_run_code_unsafe', args));
    const source = readFileSync(join(dir, 'explore/actions.js'), 'utf8');
    assert.equal(source.split("getByLabel('Name')").length - 1, 1);
    assert(source.includes(code.trim()));
    assert(source.length < code.length + 200);
    assert.match(source, /started; evidenceId=/);
    assert.match(source, /\/\/ completed/);
    const records = audit(dir);
    assert.deepEqual(records.find((r) => r.status === 'started').arguments, args);
    assert.deepEqual(records.find((r) => r.status === 'completed' && r.id).arguments, args);
    const detail = JSON.parse(readFileSync(join(dir, 'tool-results', result.actions[0].evidenceId + '.json'), 'utf8'));
    assert.deepEqual(detail.arguments, args);
    assert(detail.response.content[0].text.includes(code));
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitization does not truncate history and bounds pathological strings and detail pages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-detail-'));
  const input = join(dir, 'input');
  writeFileSync(input, '\\'.repeat(100000) + ' Bearer abcdef password=hidden ' + JSON.stringify({ password: 'hidden json' }));
  const service = await stageTools({
    readFiles: [input],
    specPath: join(dir, 'spec.ts'),
    runDir: dir,
  });
  try {
    const evidence = new StageEvidence();
    const code = "await page.goto('https://example.test/items?filter=open&page=2#section');";
    assert.equal(evidence.cleanText(code), code);
    const scrubbed = evidence.cleanText("await page.goto('https://user:private@example.test/items?token=secret&page=2');");
    assert(!scrubbed.includes('private'));
    assert(!scrubbed.includes('=secret'));
    assert(scrubbed.includes('page=2'));
    assert.equal(evidence.cleanText(scrubbed), scrubbed);
    for (const [name, args] of [
      ['read_input', { path: input }],
      ['read_inputs', { paths: Array(8).fill(input) }],
    ] as const) {
      const result = await service.call(name, args);
      assert(resultBytes(result) <= RESULT_BYTES, String(resultBytes(result)));
    }
    for (const name of readdirSync(join(dir, 'tool-results'))) {
      const data = readFileSync(join(dir, 'tool-results', name), 'utf8');
      assert(data.length > 100000);
      assert(!data.includes('abcdef'));
      assert(!data.includes('hidden'));
      const page = await service.call('qa_tool_result', {
        id: name.replace('.json', ''),
      });
      assert(resultBytes(page) <= RESULT_BYTES);
    }
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
