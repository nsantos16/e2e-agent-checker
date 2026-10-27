import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stageTools, type StageConfig } from '../src/stage-tools.ts';
import { runCodex } from '../src/providers/codex.ts';
import { RESULT_BYTES, resultBytes } from '../src/stage-results.ts';

const stageMcp = new URL('../src/stage-mcp.ts', import.meta.url).pathname;
const parse = (r: any) => JSON.parse(r.content[0].text);
const action = { tool: 'browser_verify_text', arguments: { target: 'one' } };
function setup(browser: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-adapter-'));
  const oldPath = process.env.PATH,
    oldFixture = process.env.STAGE_FIXTURE_DIR;
  for (const [name, fixture] of [
    ['npx', 'stage-browser-mcp.ts'],
    ['codex', 'codex-stage.ts'],
  ]) {
    writeFileSync(
      join(dir, name),
      `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('./fixtures/' + fixture, import.meta.url).pathname)});`,
      { mode: 0o755 },
    );
  }
  process.env.PATH = dir + ':' + oldPath;
  process.env.STAGE_FIXTURE_DIR = dir;
  const configPath = join(dir, 'stage.json');
  const input = join(dir, 'input.txt');
  writeFileSync(input, 'An allowed QA input');
  const browserConfig = join(dir, 'browser.json');
  writeFileSync(browserConfig, '{}');
  mkdirSync(join(dir, 'explore'));
  const config: StageConfig = browser
    ? {
        browserConfig,
        runDir: dir,
        actionsPath: join(dir, 'explore/actions.js'),
      }
    : { runDir: dir, specPath: join(dir, 'case.spec.ts'), readFiles: [input] };
  writeFileSync(configPath, JSON.stringify(config));
  return {
    dir,
    input,
    config,
    configPath,
    cleanup() {
      process.env.PATH = oldPath;
      if (oldFixture === undefined) delete process.env.STAGE_FIXTURE_DIR;
      else process.env.STAGE_FIXTURE_DIR = oldFixture;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const codexRun = (dir: string, signal?: AbortSignal) => ({
  prompt: 'fixture',
  model: 'fixture',
  cwd: dir,
  transcriptPath: join(dir, 'transcript.jsonl'),
  tools: [],
  allowedTools: [],
  signal,
});
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(check());
}

for (const browser of [true, false])
  test(`Codex dynamic tools deliver ${browser ? 'browser calls' : 'grouped reads'} and saved details with isolation unchanged`, async () => {
    const f = setup(browser);
    const service = await stageTools(f.config);
    try {
      writeFileSync(
        join(f.dir, 'plan.json'),
        JSON.stringify([
          browser ? action : { tool: 'read_inputs', arguments: { paths: [f.input] } },
          {
            tool: 'qa_tool_result',
            arguments: { id: '$evidence', limit: 2000 },
          },
          browser
            ? {
                tool: 'browser_verify_text',
                arguments: { target: 'reject' },
              }
            : {
                tool: 'read_inputs',
                arguments: { paths: [f.input, f.config.specPath, join(f.dir, 'not-allowed')] },
              },
          { tool: 'shell', arguments: {} },
        ]),
      );
      const result = await runCodex(codexRun(f.dir), service);
      assert.equal(result.resultText, '{"ok":true}');
      assert.equal(result.metrics.toolCalls, 3);
      const replies = JSON.parse(readFileSync(join(f.dir, 'provider-results.json'), 'utf8'));
      assert.equal(replies[0].result.success, true);
      const value = JSON.parse(replies[0].result.contentItems[0].text);
      if (browser) {
        assert.deepEqual(value.completed, [1]);
        assert.equal(value.actions[0].assertion, 'passed');
      } else assert.equal(value.inputs[0].text, 'An allowed QA input');
      assert.equal(replies[1].result.success, true);
      assert.match(replies[1].result.contentItems[0].text, browser ? /browser_verify_text/ : /An allowed QA input/);
      assert.equal(replies[2].result.success, false);
      if (browser) assert.equal(JSON.parse(replies[2].result.contentItems[0].text).actions[0].assertion, 'failed');
      else {
        const partial = JSON.parse(replies[2].result.contentItems[0].text);
        assert.equal(partial.inputs[0].text, 'An allowed QA input');
        assert.match(partial.inputs[1].error, /ENOENT/);
        assert(partial.inputs[2].error);
        assert.equal(JSON.parse(replies[1].result.contentItems[0].text).format, 'text');
      }
      assert(replies[3].error);
      assert(resultBytes(replies[0]) <= RESULT_BYTES);
      const thread = JSON.parse(readFileSync(join(f.dir, 'thread.json'), 'utf8'));
      assert(!thread.dynamicTools.some((t: any) => t.name === 'browser_batch'));
      assert.equal(thread.sandbox, 'read-only');
      assert.equal(thread.approvalPolicy, 'never');
      assert.deepEqual(thread.config.mcp_servers, {
        unrelated: { enabled: false },
      });
      assert.equal(thread.config.features.shell_tool, false);
      assert.equal(thread.config.apps._default.enabled, false);
      assert.deepEqual(
        thread.dynamicTools.map((t: any) => t.name),
        service.tools.map((t) => t.name),
      );
      assert(!thread.dynamicTools.some((t: any) => (browser ? t.name === 'write_spec' : t.name.startsWith('browser_'))));
    } finally {
      await service.close();
      f.cleanup();
    }
  });

for (const browser of [true, false])
  test(`Claude stage MCP exposes the same ${browser ? 'browser call' : 'grouped read'} contract and detail retrieval`, async () => {
    const f = setup(browser),
      client = new Client({ name: 'fixture', version: '1' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [stageMcp, f.configPath],
          env: { ...process.env } as Record<string, string>,
          stderr: 'pipe',
        }),
      );
      const { tools } = await client.listTools();
      assert(tools.some((t) => t.name === (browser ? 'browser_verify_text' : 'read_inputs')));
      assert(!tools.some((t) => (browser ? t.name === 'write_spec' : t.name.startsWith('browser_'))));
      const result = await client.callTool(
        browser ? { name: action.tool, arguments: action.arguments } : { name: 'read_inputs', arguments: { paths: [f.input] } },
      );
      assert.equal(result.isError, false);
      const value = parse(result);
      if (browser) {
        assert.deepEqual(value.completed, [1]);
        assert.equal(value.actions[0].assertion, 'passed');
      } else assert.equal(value.inputs[0].text, 'An allowed QA input');
      const id = browser ? value.actions[0].evidenceId : value.inputs[0].evidenceId;
      const detail = await client.callTool({
        name: 'qa_tool_result',
        arguments: { id, limit: 2000 },
      });
      assert.equal(detail.isError, false);
      assert.match(parse(detail).text, browser ? /browser_verify_text/ : /An allowed QA input/);
      assert(resultBytes(result) <= RESULT_BYTES);
      assert(!tools.some((t) => t.name === 'browser_batch'));
      const failed = await client.callTool(
        browser
          ? {
              name: 'browser_verify_text',
              arguments: { target: 'reject' },
            }
          : {
              name: 'read_inputs',
              arguments: { paths: [f.input, f.config.specPath, join(f.dir, 'not-allowed')] },
            },
      );
      assert.equal(failed.isError, true);
      if (browser) assert.equal(parse(failed).actions[0].assertion, 'failed');
      else {
        assert.equal(parse(failed).inputs[0].text, 'An allowed QA input');
        assert.match(parse(failed).inputs[1].error, /ENOENT/);
        assert(parse(failed).inputs[2].error);
        assert.equal(parse(detail).format, 'text');
      }
      assert.equal((await client.callTool({ name: 'shell', arguments: {} })).isError, true);
    } finally {
      await client.close();
      f.cleanup();
    }
  });

test('Codex cancellation reaches an in-flight browser call and preserves uncertainty before scope cleanup', async () => {
  const f = setup(true),
    controller = new AbortController();
  const service = await stageTools(f.config);
  try {
    writeFileSync(
      join(f.dir, 'plan.json'),
      JSON.stringify([
        { tool: 'browser_click', arguments: { target: 'done' } },
        { tool: 'browser_click', arguments: { target: 'slow' } },
      ]),
    );
    const task = assert.rejects(runCodex(codexRun(f.dir, controller.signal), service), /test cancel/);
    await waitFor(() => existsSync(join(f.dir, 'started')));
    controller.abort(new Error('test cancel'));
    await task;
    await service.close();
    const history = readFileSync(join(f.dir, 'explore/actions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    const uncertain = history.find((r) => r.id && r.status === 'uncertain');
    assert(uncertain);
    assert(history.some((r) => r.id && r.status === 'completed'));
    assert.equal(history.filter((r) => r.status === 'started').length, 2);
  } finally {
    await service.close();
    f.cleanup();
  }
});

test('MCP per-request cancellation halts the browser and the next request cannot retry the mutation', async () => {
  const f = setup(true),
    client = new Client({ name: 'fixture', version: '1' }),
    controller = new AbortController();
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [stageMcp, f.configPath],
        env: { ...process.env } as Record<string, string>,
        stderr: 'pipe',
      }),
    );
    const task = assert.rejects(
      client.callTool(
        {
          name: 'browser_click',
          arguments: { target: 'slow' },
        },
        undefined,
        { signal: controller.signal },
      ),
      /cancel/,
    );
    await waitFor(() => existsSync(join(f.dir, 'started')));
    controller.abort(new Error('request cancelled'));
    await task;
    const next = await client.callTool({
      name: 'browser_click',
      arguments: { target: 'two' },
    });
    assert.equal(next.isError, true);
    assert.match(JSON.stringify(next), /halted/);
    const history = readFileSync(join(f.dir, 'explore/actions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    const batch = history.find((r) => r.kind === 'batch' && r.actions[0].status === 'uncertain');
    assert(batch);
    assert(history.some((r) => r.kind === 'batch' && r.unexecuted.length === 1));
    assert.equal(history.filter((r) => r.status === 'started').length, 1);
    const detail = await client.callTool({
      name: 'qa_tool_result',
      arguments: { id: batch.evidenceId },
    });
    assert.equal(detail.isError, false);
  } finally {
    await client.close();
    f.cleanup();
  }
});
