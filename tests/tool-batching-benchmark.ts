// Reproducible localhost benchmark of tool boundaries; no model requests or application accounts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { stageTools } from '../src/stage-tools.ts';
import { browserSections, RESULT_BYTES, resultBytes } from '../src/stage-results.ts';
import type { ToolService } from '../src/providers/codex.ts';

const root = new URL('..', import.meta.url).pathname;
mkdirSync(join(root, 'runs'), { recursive: true });
const runDir = mkdtempSync(join(root, 'runs/tool-batching-benchmark-'));
const repeats = 5;
const fixture = createServer((_, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><title>Batching fixture</title><h1>Editor</h1>
    <label>Name<input id="name"></label><label>Notes<textarea id="notes"></textarea></label>
    <button id="save">Save</button><output aria-live="polite" id="result">Not saved</output>
    <script>window.saves=0;document.querySelector('#save').onclick=()=>{window.saves++;document.querySelector('#result').textContent='Saved: '+document.querySelector('#name').value+' / '+document.querySelector('#notes').value;};</script>
    <ul>${Array.from({ length: 600 }, (_, i) => `<li>Reference item ${i} <button>Inspect item ${i}</button></li>`).join('')}</ul>`);
});
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
type Measurement = {
  workflow: string;
  mode: string;
  iteration: number;
  calls: number;
  driverCalls: number;
  resultBytes: number;
  elapsedMs: number;
  assertions: number;
};
const measurements: Measurement[] = [];
const expected = {
  name: 'Ada',
  notes: 'ordered',
  saves: 1,
  message: 'Saved: Ada / ordered',
};
const evaluation =
  "() => ({name:document.querySelector('#name').value,notes:document.querySelector('#notes').value,saves:window.saves,message:document.querySelector('#result').textContent})";

async function browserRun(mode: string, iteration: number) {
  const dir = join(runDir, `${iteration}-${mode}`);
  mkdirSync(dir);
  const config = join(dir, 'browser.json');
  writeFileSync(
    config,
    JSON.stringify({
      browser: {
        browserName: 'chromium',
        isolated: true,
        launchOptions: {
          headless: true,
          executablePath: chromium.executablePath(),
        },
      },
      outputDir: join(dir, 'output'),
    }),
  );
  let service: ToolService;
  if (mode === 'legacy-raw') {
    const client = new Client({ name: 'benchmark', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.83', '--config', config],
        stderr: 'ignore',
      }),
    );
    service = {
      tools: [],
      close: () => client.close(),
      async call(name, args) {
        const result = await client.callTool({ name, arguments: args });
        // Same action-code capture as the previous stage wrapper, without network fixtures.
        for (const c of result.content as any[])
          if (c.type === 'text') {
            const match = c.text.match(/### Ran Playwright code\s*```(?:js|ts)?\n([\s\S]*?)```/);
            if (match) appendFileSync(join(dir, 'actions.js'), match[1].trim() + '\n');
          }
        return result;
      },
    };
  } else
    service = await stageTools({
      browserConfig: config,
      runDir: dir,
      actionsPath: join(dir, 'explore/actions.js'),
    });
  try {
    const nav = await service.call('browser_navigate', { url });
    assert(!nav.isError, JSON.stringify(nav));
    const snapshot = await service.call('browser_snapshot', {});
    assert(!snapshot.isError, JSON.stringify(snapshot));
    const text = mode === 'legacy-raw' ? browserSections(snapshot).Snapshot : JSON.parse(snapshot.content[0].text).state.Snapshot.text;
    const ref = (role: string, name: string) => {
      const value = text.match(new RegExp(role + ' "' + name + '" \\[ref=([^\\]]+)\\]'))?.[1];
      assert(value, `Missing observed locator ${name}: ${text.slice(0, 800)}`);
      return value;
    };
    const actions = [
      {
        tool: 'browser_type',
        arguments: { target: ref('textbox', 'Name'), text: 'Ada' },
      },
      {
        tool: 'browser_type',
        arguments: { target: ref('textbox', 'Notes'), text: 'ordered' },
      },
      { tool: 'browser_click', arguments: { target: ref('button', 'Save') } },
      { tool: 'browser_wait_for', arguments: { text: 'Saved: Ada / ordered' } },
      {
        tool: 'browser_evaluate',
        arguments: { function: evaluation },
      },
      { tool: 'browser_snapshot', arguments: {} },
    ];
    let calls = 0,
      bytes = 0;
    const results: any[] = [];
    const started = performance.now();
    if (mode === 'code-compact') {
      const code = `async (page) => {
        await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Ada');
        await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('ordered');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByText('Saved: Ada / ordered', { exact: true }).waitFor({ state: 'visible' });
        const observed = await page.evaluate(${evaluation});
        const expected = ${JSON.stringify(expected)};
        for (const key of Object.keys(expected)) if (observed[key] !== expected[key]) throw new Error(key + ': ' + JSON.stringify(observed));
        const snapshot = await page.locator('body').ariaSnapshot();
        if (!snapshot.includes('Saved: Ada / ordered')) throw new Error('Saved message absent from snapshot');
        return { observed, snapshotMatched: true };
      }`;
      const result = await service.call('browser_run_code_unsafe', { code });
      calls++;
      bytes += resultBytes(result);
      results.push(result);
      assert(!result.isError, JSON.stringify(result));
      assert(resultBytes(result) <= RESULT_BYTES);
      const value = JSON.parse(result.content[0].text);
      assert.deepEqual(value.completed, [1]);
      const observed = JSON.parse(value.actions[0].result);
      assert.deepEqual(observed.observed, expected);
      assert.equal(observed.snapshotMatched, true);
    } else {
      for (const action of actions) {
        const result = await service.call(action.tool, action.arguments);
        calls++;
        bytes += resultBytes(result);
        results.push(result);
        assert(!result.isError, JSON.stringify(result));
        if (mode !== 'legacy-raw') assert(resultBytes(result) <= RESULT_BYTES);
        if (action.tool === 'browser_evaluate') {
          const observed = mode === 'legacy-raw' ? browserSections(result).Result : JSON.parse(result.content[0].text).actions[0].result;
          assert.deepEqual(JSON.parse(observed), expected);
        }
        if (action.tool === 'browser_snapshot') {
          const observed =
            mode === 'legacy-raw' ? browserSections(result).Snapshot : JSON.parse(result.content[0].text).state.Snapshot.text;
          assert.match(observed, /Saved: Ada \/ ordered/);
        }
      }
    }
    measurements.push({
      workflow: 'browser',
      mode,
      iteration,
      calls,
      driverCalls: mode === 'code-compact' ? 1 : actions.length,
      resultBytes: bytes,
      elapsedMs: performance.now() - started,
      assertions: 6,
    });
    writeFileSync(join(dir, 'measured-results.json'), JSON.stringify(results));
    if (mode === 'code-compact') {
      // Negative control outside the timed workflow: the same assertion must stop an extra save.
      const failed = await service.call('browser_run_code_unsafe', {
        code: `async (page) => {
          const observed = await page.evaluate(${evaluation});
          if (observed.saves !== 2) throw new Error('Expected two saves, received ' + observed.saves);
          await page.getByRole('button', { name: 'Save', exact: true }).click();
        }`,
      });
      assert(failed.isError);
      assert.equal(JSON.parse(failed.content[0].text).actions[0].status, 'failed');
      const check = await service.call('browser_evaluate', {
        function: evaluation,
      });
      assert.deepEqual(JSON.parse(JSON.parse(check.content[0].text).actions[0].result), expected);
    }
  } finally {
    await service.close();
  }
}

async function inputRun(mode: string, iteration: number) {
  const dir = join(runDir, `inputs-${iteration}-${mode}`);
  mkdirSync(dir);
  const paths = Array.from({ length: 6 }, (_, i) => join(dir, `input-${i}.txt`));
  const contents = paths.map(
    (_, i) => `QA input ${i}\n` + 'A complete fixture paragraph with the required assertion and locator.\n'.repeat(12),
  );
  paths.forEach((path, i) => writeFileSync(path, contents[i]));
  const service = await stageTools({
    readFiles: paths,
    specPath: join(dir, 'case.spec.ts'),
    runDir: dir,
  });
  let calls = 0,
    bytes = 0;
  const started = performance.now();
  try {
    if (mode === 'grouped') {
      const result = await service.call('read_inputs', { paths });
      calls++;
      bytes += resultBytes(result);
      assert(!result.isError);
      assert(resultBytes(result) <= RESULT_BYTES);
      const value = JSON.parse(result.content[0].text);
      assert.deepEqual(
        value.inputs.map((i: any) => i.text),
        contents,
      );
      assert(value.inputs.every((i: any) => !i.truncated));
    } else
      for (let i = 0; i < paths.length; i++) {
        // For these short files the old read_input and current read_input return identical text.
        const result = await service.call('read_input', { path: paths[i] });
        calls++;
        bytes += resultBytes(result);
        assert.equal(result.content[0].text, contents[i]);
      }
    measurements.push({
      workflow: 'inputs',
      mode,
      iteration,
      calls,
      driverCalls: 0,
      resultBytes: bytes,
      elapsedMs: performance.now() - started,
      assertions: 6,
    });
  } finally {
    await service.close();
  }
}

try {
  const modes = ['legacy-raw', 'single-compact', 'code-compact'];
  for (let iteration = 0; iteration < repeats; iteration++) {
    // Rotate mode order to reduce systematic browser warm-up/order bias.
    for (let k = 0; k < modes.length; k++) await browserRun(modes[(iteration + k) % modes.length], iteration);
    for (const mode of iteration % 2 ? ['grouped', 'single'] : ['single', 'grouped']) await inputRun(mode, iteration);
    console.log(`Completed iteration ${iteration + 1}/${repeats}`);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = [...new Set(measurements.map((m) => m.workflow + '/' + m.mode))].map((key) => {
    const rows = measurements.filter((m) => m.workflow + '/' + m.mode === key);
    return {
      workflow: key,
      samples: rows.length,
      calls: median(rows.map((r) => r.calls)),
      driverCalls: median(rows.map((r) => r.driverCalls)),
      resultBytes: median(rows.map((r) => r.resultBytes)),
      elapsedMedianMs: median(rows.map((r) => r.elapsedMs)),
      elapsedMinMs: Math.min(...rows.map((r) => r.elapsedMs)),
      elapsedMaxMs: Math.max(...rows.map((r) => r.elapsedMs)),
      assertions: rows[0].assertions,
    };
  });
  const report = {
    runDir,
    modelCalls: 0,
    repeats,
    runtime: process.version,
    platform: process.platform,
    driver: '@playwright/mcp@0.0.83',
    summary,
    measurements,
    methodology:
      'Six browser operations through individual tools or one existing code-execution call, with unchanged checks: wait for saved message, exact name/notes/save count/message, and final accessibility snapshot. The native code call throws on each mismatch before proceeding. Navigation and initial locator discovery are common setup, excluded. Six full small input files, no truncated content or omitted reads. Count and bytes measure model-facing tool calls/results without a model or provider framing. Elapsed time measures local tool execution, not model latency. Raw mode reproduces prior browser forwarding/action-code recording; compact modes also persist detailed evidence. Rotating mode order; five fresh contexts per mode; negative assertion controls excluded from timings.',
  };
  writeFileSync(join(runDir, 'benchmark.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
}
