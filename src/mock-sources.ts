import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { TestCase } from './cases.ts';
import { isAssertion, mockInputSchema, mockSuiteSchema, type MockInput, type MockSuite } from './mock-contract.ts';
const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const formats = require('ajv-formats');
export const mockHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type SourceSnapshot = {
  input: MockInput;
  revision: string | null;
  fingerprint: string;
  files: {
    path: string;
    role: 'backend' | 'schema' | 'frontend';
    sha256: string;
    text: string;
  }[];
};
export function captureMockSources(raw: MockInput, frontendRoot?: string): SourceSnapshot {
  const input = mockInputSchema.parse(raw);
  input.backendRoot = realpathSync(input.backendRoot);
  let revision: string | null = null;
  try {
    revision = execFileSync('git', ['-C', input.backendRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* non-git sources retain content hashes */
  }
  if (input.expectedRevision && input.expectedRevision !== revision)
    throw Object.assign(new Error('SOURCE_CHANGED: backend revision does not match'), { code: 'SOURCE_CHANGED' });
  let total = 0;
  const files: SourceSnapshot['files'] = [];
  for (const [role, paths, root] of [
    ['backend', input.sourceFiles, input.backendRoot],
    ['schema', input.schemaFiles, input.backendRoot],
    ['frontend', input.frontendFiles, frontendRoot],
  ] as const) {
    for (const path of [...new Set(paths)].sort()) {
      if (!root || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
        throw new Error('INVALID_INPUT: source files must be relative to their explicit root');
      const canonical = realpathSync(resolve(root, path));
      const rel = relative(realpathSync(root), canonical);
      if (rel.startsWith('..') || isAbsolute(rel) || !statSync(canonical).isFile())
        throw new Error('INVALID_INPUT: source escapes root or is not a regular file');
      if (statSync(canonical).size > 256_000) throw new Error('INVALID_INPUT: source file exceeds 256 KB; narrow the source input');
      const text = readFileSync(canonical, 'utf8');
      total += Buffer.byteLength(text);
      if (total > 2_000_000 || text.includes('\0')) throw new Error('INVALID_INPUT: source bundle is too large or binary');
      files.push({ path, role, text, sha256: createHash('sha256').update(text).digest('hex') });
    }
  }
  // HEAD is provenance; unrelated commits do not invalidate identical relevant files.
  return {
    input,
    revision,
    files,
    fingerprint: mockHash({ input, files: files.map(({ text, ...f }) => f) }),
  };
}
function validateContract(snapshot: SourceSnapshot, ref: { file: string; pointer: string }, body: unknown) {
  const file = snapshot.files.find((f) => f.role === 'schema' && f.path === ref.file);
  if (!file) throw new Error(`CONTRACT_INVALID: schema not supplied: ${ref.file}`);
  let document: any;
  try {
    document = JSON.parse(file.text);
  } catch {
    throw new Error(`CONTRACT_UNAVAILABLE: ${ref.file} is not JSON Schema; record the unavailable contract explicitly`);
  }
  if (ref.pointer && !ref.pointer.startsWith('/')) throw new Error('CONTRACT_INVALID: pointer must be an RFC 6901 JSON pointer');
  let selected = document;
  for (const part of ref.pointer.split('/').slice(1)) selected = selected?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  if (selected === undefined) throw new Error(`CONTRACT_INVALID: pointer not found in ${ref.file}`);
  const ajv = new (document.$schema?.includes('2020-12') ? Ajv2020 : Ajv)({
    strict: true,
    allErrors: true,
    validateFormats: true,
  });
  formats(ajv);
  // Never fetch/execute schemas. Local fragment refs are resolved from the supplied document.
  if (document.openapi) {
    if (!ref.pointer) throw new Error('CONTRACT_INVALID: select a schema within the OpenAPI document');
    // Document metadata is not a response schema. Fragment refs still resolve to
    // the original components/paths; selected schema keywords remain strict.
    for (const keyword of ['openapi', 'info', 'paths', 'components', 'servers', 'tags', 'security', 'externalDocs'])
      ajv.addKeyword({ keyword, valid: true });
  }
  const schema = ref.pointer ? { $ref: `urn:checker:contract#${ref.pointer}` } : document;
  if (ref.pointer) ajv.addSchema(document, 'urn:checker:contract');
  const validate = ajv.compile(schema);
  if (!validate(body)) throw new Error(`CONTRACT_INVALID: ${ref.file}${ref.pointer}: ${ajv.errorsText(validate.errors)}`);
}
export function validateMockSuite(raw: unknown, snapshot: SourceSnapshot, testCase: TestCase): MockSuite {
  if (JSON.stringify(raw)?.length > 2_000_000) throw new Error('SUITE_INVALID: suite exceeds 2 MB');
  const suite = mockSuiteSchema.parse(raw);
  const ids = new Set<string>();
  const covered = new Set<number>();
  for (const scenario of suite.scenarios) {
    if (ids.has(scenario.id)) throw new Error('SUITE_INVALID: duplicate scenario ID');
    ids.add(scenario.id);
    const positions = new Set<number>();
    for (const step of scenario.steps) {
      const original = testCase.steps.find((s) => s.position === step.position);
      if (!original || !original.expected_result?.includes(step.acceptance) || positions.has(step.position))
        throw new Error('SUITE_INVALID: each step needs a unique case position and exact acceptance quotation');
      if (!step.operations.some((o) => isAssertion(o.op))) throw new Error('SUITE_INVALID: every step needs an observable assertion');
      positions.add(step.position);
      covered.add(step.position);
    }
    const mocks = new Set<string>();
    for (const mock of scenario.mocks) {
      if (mocks.has(mock.id)) throw new Error('SUITE_INVALID: duplicate mock ID');
      mocks.add(mock.id);
      const parsed = new URL(mock.url, 'http://frontend.invalid');
      if (parsed.search) throw new Error('SUITE_INVALID: provide mock query parameters in query, not URL');
      for (const path of mock.sourceFiles)
        if (!snapshot.files.some((f) => f.role === 'backend' && f.path === path))
          throw new Error(`SUITE_INVALID: uncited backend source ${path}`);
      if (mock.requestContract) validateContract(snapshot, mock.requestContract, mock.body);
      for (const response of mock.responses) {
        if (!!response.contract === !!response.unavailableContract)
          throw new Error('SUITE_INVALID: provide a schema reference or an explicit unavailable-contract reason');
        if ([204, 205, 304].includes(response.status) && response.body !== null)
          throw new Error('SUITE_INVALID: bodyless status requires null body');
        if (response.contract) validateContract(snapshot, response.contract, response.body);
      }
    }
  }
  if (!suite.scenarios.some((s) => s.kind === 'success')) throw new Error('SUITE_INVALID: include a success scenario');
  if (testCase.steps.some((s) => !covered.has(s.position))) throw new Error('SUITE_INVALID: suite must cover every case step');
  return suite;
}
// After the first execution, only locator repairs are permitted. Expected values,
// scenario membership, request fixtures and operation order remain immutable.
export const mockSemantics = (suite: MockSuite) =>
  mockHash({
    ...suite,
    scenarios: suite.scenarios.map((scenario) => ({
      ...scenario,
      steps: scenario.steps.map((step) => ({
        ...step,
        operations: step.operations.map((operation) => ('locator' in operation ? { ...operation, locator: '<locator>' } : operation)),
      })),
    })),
  });
export const compileMockSpec = (suite: MockSuite, input: MockInput) =>
  `import { test } from '@playwright/test';\nimport { runMockScenario } from '../../mock-suite.ts';\nconst suite = JSON.parse(${JSON.stringify(JSON.stringify(suite))});\nconst allowed = ${JSON.stringify(input.allowedLiveRequests)};\nconst scenario = suite.scenarios.find(s => s.id === process.env.E2E_MOCK_SCENARIO);\nif (!scenario) throw new Error('Select an E2E_MOCK_SCENARIO from the saved suite');\ntest(scenario.id + ': ' + scenario.title, async ({ page }) => { await runMockScenario(page, suite, scenario.id, allowed); });\n`;
