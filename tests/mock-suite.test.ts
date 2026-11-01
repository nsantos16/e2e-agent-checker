import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockBackendFixture, deriveFixtureSuite } from './fixtures/mock-backend.ts';
import { captureMockSources, validateMockSuite, mockSemantics, compileMockSpec } from '../src/mock-sources.ts';
import { matchesMock } from '../src/mock-network.ts';
import { stageTools } from '../src/stage-tools.ts';
import { captureBuild, compatibilityContext, publishSavedSpec, readSavedSpec, specRequirements } from '../src/saved-specs.ts';
import { atomicJson } from '../src/network.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mock-suite-'));
  const f = mockBackendFixture(dir);
  const snapshot = captureMockSources(f.input);
  const suite = deriveFixtureSuite(snapshot);
  return {
    ...f,
    dir,
    snapshot,
    suite,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test('source-derived fixtures validate against schemas and anchor all assertions to case acceptance', () => {
  const f = fixture();
  try {
    assert.deepEqual(validateMockSuite(f.suite, f.snapshot, f.testCase), f.suite);
    const broken = structuredClone(f.suite);
    broken.scenarios[0].mocks[0].responses[0].body = {
      id: 7,
      status: 'paid',
      amount: '100',
    };
    assert.throws(() => validateMockSuite(broken, f.snapshot, f.testCase), /CONTRACT_INVALID/);
    broken.scenarios[0].mocks[0].responses[0].contract = {
      file: 'missing.json',
      pointer: '',
    };
    assert.throws(() => validateMockSuite(broken, f.snapshot, f.testCase), /not supplied/);
    const unanchored = structuredClone(f.suite);
    unanchored.scenarios[0].steps[0].acceptance = 'Observed current behavior';
    assert.throws(() => validateMockSuite(unanchored, f.snapshot, f.testCase), /acceptance/);
    assert.throws(
      () => validateMockSuite({ ...f.suite, scenarios: f.suite.scenarios.slice(0, 1) }, f.snapshot, f.testCase),
      /every case step/,
    );
    const unavailable = structuredClone(f.suite);
    delete unavailable.scenarios[0].mocks[0].responses[0].contract;
    assert.throws(() => validateMockSuite(unavailable, f.snapshot, f.testCase), /unavailable-contract/);
    unavailable.scenarios[0].mocks[0].responses[0].unavailableContract = 'Response contract absent; inferred from handler';
    assert.ok(validateMockSuite(unavailable, f.snapshot, f.testCase));
  } finally {
    f.cleanup();
  }
});
test('source provenance is scoped, content sensitive and rejects traversal and symlink escapes', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.backend, 'unrelated.ts'), 'unrelated');
    assert.equal(captureMockSources(f.input).fingerprint, f.snapshot.fingerprint);
    writeFileSync(join(f.backend, 'service.ts'), 'changed contract');
    assert.notEqual(captureMockSources(f.input).fingerprint, f.snapshot.fingerprint);
    assert.throws(() => captureMockSources({ ...f.input, sourceFiles: ['../cases.json'] }), /relative/);
    symlinkSync(join(f.dir, 'cases.json'), join(f.backend, 'escape.json'));
    assert.throws(() => captureMockSources({ ...f.input, sourceFiles: ['escape.json'] }), /escapes/);
    assert.throws(() => captureMockSources({ ...f.input, expectedRevision: 'missing' }), /SOURCE_CHANGED/);
  } finally {
    f.cleanup();
  }
});
test('matching includes exact methods, URL origin/path, multi-value query and JSON body', () => {
  const f = fixture();
  try {
    const mock = {
      ...f.suite.scenarios[0].mocks[0],
      method: 'POST' as const,
      query: { tag: ['a', 'b'] },
      body: { id: 7 },
    };
    const request = {
      method: 'POST',
      url: 'https://app.test/api/invoice?tag=a&tag=b',
      body: { id: 7 },
    };
    assert(matchesMock(mock, request, 'https://app.test'));
    for (const override of [
      { method: 'GET' },
      { body: { id: 8 } },
      { body: undefined },
      { url: request.url + '&extra=x' },
      { url: request.url.replace('app.test', 'other.test') },
    ])
      assert(!matchesMock(mock, { ...request, ...override }, 'https://app.test'));
  } finally {
    f.cleanup();
  }
});
test('mock tools require source inspection, deny raw code and lock scenario semantics after execution', async () => {
  const f = fixture();
  const sources = join(f.dir, 'sources.json'),
    casePath = join(f.dir, 'case.json'),
    spec = join(f.dir, 'case.spec.ts');
  mkdirSync(join(f.dir, 'mock'));
  mkdirSync(join(f.dir, 'codify'));
  atomicJson(sources, f.snapshot);
  atomicJson(casePath, f.testCase);
  const service = await stageTools({
    runDir: f.dir,
    specPath: spec,
    mockSources: sources,
    mockCase: casePath,
    readFiles: [sources, casePath],
  });
  try {
    assert(!service.tools.some((t) => t.name === 'write_spec'));
    assert((await service.call('write_mock_suite', { suite: f.suite })).isError);
    assert(!(await service.call('read_inputs', { paths: [sources, casePath] })).isError);
    assert(!(await service.call('write_mock_suite', { suite: f.suite })).isError);
    assert.equal(readFileSync(spec, 'utf8'), compileMockSpec(f.suite, f.input));
    atomicJson(join(f.dir, 'mock/locked.json'), {
      semantics: mockSemantics(f.suite),
    });
    const weaker = structuredClone(f.suite);
    (weaker.scenarios[1].steps[0].operations[1] as { value: string }).value = 'Current broken behavior';
    assert((await service.call('write_mock_suite', { suite: weaker })).isError);
    assert((await service.call('write_spec', { source: 'test.skip()' })).isError);
    const repair = structuredClone(f.suite);
    (repair.scenarios[0].steps[0].operations[1] as any).locator.value = 'invoice-result';
    assert(!(await service.call('write_mock_suite', { suite: repair })).isError);
  } finally {
    await service.close();
    f.cleanup();
  }
});
test('saved mock suite reuse invalidates changed schemas, cases, fixtures and live allowances; live mode stays separate', () => {
  const f = fixture();
  try {
    const env = {
      id: 'fixture',
      revision: '1',
      name: 'Fixture',
      kind: 'hosted' as const,
      baseUrl: 'https://app.test',
      devMode: 'test',
      users: [
        {
          id: 'qa',
          name: 'QA',
          usernameRef: 'env://QA_USER',
          passwordRef: 'env://QA_PASS',
        },
      ],
    };
    const context = {
      ...compatibilityContext(f.testCase, specRequirements(env, env.users[0], env.baseUrl)),
      mock: { fingerprint: f.snapshot.fingerprint },
    };
    for (const d of ['mock', 'codify', 'explore']) mkdirSync(join(f.dir, d));
    atomicJson(join(f.dir, 'mock/suite.json'), f.suite);
    atomicJson(join(f.dir, 'mock/sources.json'), f.snapshot);
    atomicJson(join(f.dir, 'explore/case.json'), f.testCase);
    atomicJson(join(f.dir, 'explore/report.json'), {
      caseId: f.testCase.id,
      verdict: 'fail',
      steps: [],
    });
    writeFileSync(join(f.dir, 'codify/LOCAL-1.spec.ts'), compileMockSpec(f.suite, f.input));
    publishSavedSpec(f.dir, context, captureBuild(env.baseUrl));
    assert.equal(typeof readSavedSpec(f.dir, context), 'object');
    assert.equal(readSavedSpec(f.dir, { ...context, mock: undefined }), 'mock-contracts-changed');
    assert.equal(
      readSavedSpec(f.dir, {
        ...context,
        case: { ...context.case, revision: 'new' },
      }),
      'case-changed',
    );
    writeFileSync(join(f.backend, 'schema.json'), '{}');
    assert.equal(
      readSavedSpec(f.dir, {
        ...context,
        mock: { fingerprint: captureMockSources(f.input).fingerprint },
      }),
      'mock-contracts-changed',
    );
    const changed = structuredClone(f.suite);
    changed.scenarios[0].mocks[0].responses[0].body = {
      id: 7,
      status: 'open',
      amount: 10,
    };
    atomicJson(join(f.dir, 'mock/suite.json'), changed);
    assert.equal(readSavedSpec(f.dir, context), 'mock-integrity-mismatch');
    atomicJson(join(f.dir, 'mock/suite.json'), f.suite);
    const input = {
      ...f.input,
      allowedLiveRequests: [...f.input.allowedLiveRequests, { ...f.input.allowedLiveRequests[0], url: '/extra' }],
    };
    assert.equal(
      readSavedSpec(f.dir, {
        ...context,
        mock: { fingerprint: captureMockSources(input).fingerprint },
      }),
      'mock-contracts-changed',
    );
  } finally {
    f.cleanup();
  }
});
test('OpenAPI component refs and JSON Schema 2020-12 enforce response shapes without executing schema code', () => {
  const f = fixture();
  try {
    const snapshot = structuredClone(f.snapshot);
    const schema = snapshot.files.find((f) => f.role === 'schema')!;
    schema.text = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Fixture', version: '1' },
      paths: {},
      components: {
        schemas: {
          Invoice: {
            type: 'object',
            required: ['amount'],
            properties: { amount: { $ref: '#/components/schemas/Amount' } },
          },
          Amount: { type: 'number' },
          Error: { type: 'object' },
        },
      },
    });
    const suite = structuredClone(f.suite);
    suite.scenarios[0].mocks[0].responses[0].contract!.pointer = '/components/schemas/Invoice';
    suite.scenarios[1].mocks[0].responses[0].contract!.pointer = '/components/schemas/Error';
    assert.ok(validateMockSuite(suite, snapshot, f.testCase));
    suite.scenarios[0].mocks[0].responses[0].body = { amount: 'wrong' };
    assert.throws(() => validateMockSuite(suite, snapshot, f.testCase), /CONTRACT_INVALID/);
    schema.text = f.snapshot.files
      .find((f) => f.role === 'schema')!
      .text.replace('http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema');
    assert.ok(validateMockSuite(f.suite, snapshot, f.testCase));
  } finally {
    f.cleanup();
  }
});
test('WebSockets require caller-approved live rules and record their coverage separately', async () => {
  const f = fixture();
  try {
    const { installMockNetwork } = await import('../src/mock-network.ts');
    let handler: (socket: any) => void = () => {};
    const context = {
      routeWebSocket: async (_: unknown, fn: typeof handler) => {
        handler = fn;
      },
      route: async () => {},
    };
    const rows: any[] = [];
    let closed = 0,
      connected = 0;
    const guard = await installMockNetwork(
      context as any,
      f.suite.scenarios[0],
      f.suite,
      [...f.input.allowedLiveRequests, { method: 'GET', url: '/hmr*', resourceTypes: ['websocket'], reason: 'Dev server hot reload' }],
      'http://app.test',
      (r) => {
        rows.splice(0, rows.length, ...r);
      },
    );
    handler({ url: () => 'ws://app.test/hmr?token=fixture', connectToServer: () => connected++, close: () => closed++ });
    handler({ url: () => 'ws://api.test/hmr', connectToServer: () => connected++, close: () => closed++ });
    assert.equal(connected, 1);
    assert.equal(closed, 1);
    assert.deepEqual(
      rows.map((r) => r.disposition),
      ['live', 'unexpected'],
    );
    assert.throws(() => guard.assertComplete(), /WebSocket allowance/);
  } finally {
    f.cleanup();
  }
});
test('locator repair exemption cannot change fixture properties also named locator', () => {
  const f = fixture();
  try {
    const original = structuredClone(f.suite),
      changed = structuredClone(f.suite);
    original.scenarios[0].mocks[0].responses[0].body = { locator: 'original' };
    changed.scenarios[0].mocks[0].responses[0].body = { locator: 'changed' };
    assert.notEqual(mockSemantics(original), mockSemantics(changed));
    const special = JSON.parse('{"__proto__":{"value":"preserved"}}');
    original.scenarios[0].mocks[0].responses[0].body = special;
    const compiled = compileMockSpec(original, f.input);
    const expression = compiled.match(/const suite = (.*);\nconst allowed/)![1];
    const roundTrip = Function('return ' + expression)();
    assert.deepEqual(roundTrip.scenarios[0].mocks[0].responses[0].body, special);
  } finally {
    f.cleanup();
  }
});
