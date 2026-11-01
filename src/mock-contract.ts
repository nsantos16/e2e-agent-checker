import { z } from 'zod';

const path = z.string().min(1).max(4096);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const json = z.json();
const url = z
  .string()
  .min(1)
  .max(2000)
  .refine((s) => {
    try {
      const u = new URL(s, 'http://frontend.invalid');
      return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.hash && !s.startsWith('//');
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) URL or a relative path, without credentials or fragments');
export const liveRequestSchema = z
  .object({
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    url,
    resourceTypes: z
      .array(z.enum(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'xhr', 'fetch', 'other', 'manifest', 'websocket']))
      .min(1),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export const mockInputSchema = z
  .object({
    backendRoot: path,
    sourceFiles: z.array(path).min(1).max(48),
    schemaFiles: z.array(path).max(32),
    frontendFiles: z.array(path).max(32).default([]),
    expectedRevision: z.string().min(1).max(200).optional(),
    // The caller, never the authoring model, decides which requests may reach a server.
    allowedLiveRequests: z.array(liveRequestSchema).min(1).max(100),
  })
  .strict();
export type MockInput = z.infer<typeof mockInputSchema>;
const contract = z.object({ file: path, pointer: z.string().max(2000).default('') }).strict();
const locator = z
  .object({
    kind: z.enum(['testId', 'role', 'text', 'label', 'css']),
    value: z.string().min(1).max(1000),
    name: z.string().max(1000).optional(),
  })
  .strict();
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('goto'), url }).strict(),
  z.object({ op: z.literal('click'), locator }).strict(),
  z.object({ op: z.literal('fill'), locator, value: z.string().max(12000) }).strict(),
  z.object({ op: z.literal('press'), locator, key: z.string().max(100) }).strict(),
  z.object({ op: z.literal('check'), locator, checked: z.boolean() }).strict(),
  z.object({ op: z.literal('select'), locator, value: z.string().max(1000) }).strict(),
  z.object({ op: z.literal('visible'), locator }).strict(),
  z.object({ op: z.literal('hidden'), locator }).strict(),
  z.object({ op: z.literal('text'), locator, value: z.string().max(12000) }).strict(),
  z.object({ op: z.literal('value'), locator, value: z.string().max(12000) }).strict(),
  z
    .object({
      op: z.literal('count'),
      locator,
      value: z.number().int().min(0).max(10000),
    })
    .strict(),
  z.object({ op: z.literal('url'), url }).strict(),
]);
export const mockSuiteSchema = z
  .object({
    version: z.literal(1),
    assumptions: z.array(z.string().min(1).max(2000)).max(50),
    analysis: z
      .object({
        routes: z.string().min(1).max(12000),
        validation: z.string().min(1).max(12000),
        permissions: z.string().min(1).max(12000),
        transitions: z.string().min(1).max(12000),
        omittedScenarios: z.string().min(1).max(4000),
      })
      .strict(),
    scenarios: z
      .array(
        z
          .object({
            id,
            title: z.string().min(1).max(300),
            kind: z.enum(['success', 'error', 'empty', 'permission', 'boundary']),
            // Exact quotations anchor the assertions to the user's case, not observed UI behavior.
            steps: z
              .array(
                z
                  .object({
                    position: z.number().int().positive(),
                    acceptance: z.string().min(1).max(6000),
                    operations: z.array(operation).min(1).max(80),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
            mocks: z
              .array(
                z
                  .object({
                    id,
                    method: liveRequestSchema.shape.method,
                    url,
                    query: z.record(z.string(), z.array(z.string())).default({}),
                    body: json.optional(),
                    requestContract: contract.optional(),
                    sourceFiles: z.array(path).min(1).max(20),
                    responses: z
                      .array(
                        z
                          .object({
                            status: z.number().int().min(200).max(599),
                            headers: z.record(z.string(), z.string()).default({}),
                            body: json,
                            contract: contract.optional(),
                            unavailableContract: z.string().min(1).max(2000).optional(),
                          })
                          .strict(),
                      )
                      .min(1)
                      .max(100),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type MockSuite = z.infer<typeof mockSuiteSchema>;
export type MockScenario = MockSuite['scenarios'][number];
export const mockedCoverage = 'Frontend behavior under supplied backend responses; the real backend is not executed or proved.';
export const isAssertion = (op: string) => ['visible', 'hidden', 'text', 'value', 'count', 'url'].includes(op);
