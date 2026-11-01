// Disposable source and case fixture. No backend listener or live model is used.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaseCatalog } from '../../src/cases.ts';
import { mockInputSchema, type MockSuite } from '../../src/mock-contract.ts';
import type { SourceSnapshot } from '../../src/mock-sources.ts';

export function mockBackendFixture(dir: string) {
  const backend = join(dir, 'backend');
  mkdirSync(backend, { recursive: true });
  writeFileSync(
    join(backend, 'routes.ts'),
    `import { invoice } from './service';
// GET /api/invoice?currency=USD; read permission required, invalid currency => 400.
export const route = (req, res) => {
  if (!req.user.canRead) return res.status(403).json({"error":"Forbidden"});
  if (req.query.currency !== 'USD') return res.status(400).json({"error":"Invalid currency"});
  return res.status(200).json(invoice());
};`,
  );
  writeFileSync(
    join(backend, 'service.ts'),
    `// The service reads a persisted invoice. No mutation occurs during listing.
export function invoice() { return {"id":7,"status":"paid","amount":100}; }`,
  );
  writeFileSync(
    join(backend, 'schema.json'),
    JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $defs: {
        Invoice: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'amount'],
          properties: {
            id: { type: 'integer', minimum: 1 },
            status: { enum: ['paid', 'open'] },
            amount: { type: 'number', minimum: 0 },
          },
        },
        Error: {
          type: 'object',
          additionalProperties: false,
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
      },
    }),
  );
  const testCase = new CaseCatalog(join(dir, 'cases.json'), join(dir, 'fixtures')).create({
    title: 'Invoice display and permission error',
    status: 'active',
    steps: [
      {
        action: 'Open invoice with read permission',
        expected_result: 'Show Paid: $100 and Fresh session.',
      },
      {
        action: 'Open invoice without read permission',
        expected_result: 'Show Access denied and Fresh session.',
      },
    ],
  });
  const input = mockInputSchema.parse({
    backendRoot: backend,
    sourceFiles: ['routes.ts', 'service.ts'],
    schemaFiles: ['schema.json'],
    allowedLiveRequests: [
      {
        method: 'GET',
        url: '/',
        resourceTypes: ['document'],
        reason: 'Disposable frontend entry page',
      },
    ],
  });
  return { backend, input, testCase };
}

// This protocol fixture simulates a model reading the supplied source. Expected UI
// text is taken from the case, response data from the service, never from the UI.
export function deriveFixtureSuite(sources: SourceSnapshot): MockSuite {
  const invoice = JSON.parse(sources.files.find((f) => f.path === 'service.ts')!.text.match(/return (\{.*?\});/)![1]);
  const forbidden = JSON.parse(sources.files.find((f) => f.path === 'routes.ts')!.text.match(/status\(403\).json\((\{.*?\})\)/)![1]);
  return {
    version: 1,
    assumptions: ['Controlled provider fixture; semantic interpretation by a live model is not tested.'],
    analysis: {
      routes: 'GET /api/invoice delegates to invoice().',
      validation: 'USD required; amount >= 0 per schema.',
      permissions: 'canRead=false returns 403 Forbidden.',
      transitions: 'Read-only invoice display; independent browser state per scenario.',
      omittedScenarios:
        'Invalid currency, empty collections and amount boundaries have no specified frontend acceptance criteria in this case.',
    },
    scenarios: [
      {
        id: 'success',
        title: 'Paid invoice',
        kind: 'success',
        steps: [
          {
            position: 1,
            acceptance: 'Show Paid: $100 and Fresh session.',
            operations: [
              { op: 'goto', url: '/' },
              {
                op: 'text',
                locator: { kind: 'testId', value: 'result' },
                value: 'Paid: $100',
              },
              {
                op: 'text',
                locator: { kind: 'testId', value: 'session' },
                value: 'Fresh',
              },
            ],
          },
        ],
        mocks: [
          {
            id: 'invoice',
            method: 'GET',
            url: '/api/invoice',
            query: { currency: ['USD'] },
            sourceFiles: ['routes.ts', 'service.ts'],
            responses: [
              {
                status: 200,
                headers: {},
                body: invoice,
                contract: { file: 'schema.json', pointer: '/$defs/Invoice' },
              },
            ],
          },
        ],
      },
      {
        id: 'permission',
        title: 'Permission denied',
        kind: 'permission',
        steps: [
          {
            position: 2,
            acceptance: 'Show Access denied and Fresh session.',
            operations: [
              { op: 'goto', url: '/' },
              {
                op: 'text',
                locator: { kind: 'testId', value: 'result' },
                value: 'Access denied',
              },
              {
                op: 'text',
                locator: { kind: 'testId', value: 'session' },
                value: 'Fresh',
              },
            ],
          },
        ],
        mocks: [
          {
            id: 'denied',
            method: 'GET',
            url: '/api/invoice',
            query: { currency: ['USD'] },
            sourceFiles: ['routes.ts'],
            responses: [
              {
                status: 403,
                headers: {},
                body: forbidden,
                contract: { file: 'schema.json', pointer: '/$defs/Error' },
              },
            ],
          },
        ],
      },
    ],
  };
}
