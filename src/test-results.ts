import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

type Step = { title: string; error?: { message?: string }; steps?: Step[] };
const error = z.object({ message: z.string().optional() }).passthrough();
const step: z.ZodType<Step> = z.lazy(() => z.object({ title: z.string(), error: error.optional(), steps: z.array(step).optional() }));
const resultSchema = z
  .object({
    status: z.string(),
    duration: z.number().nonnegative().optional(),
    startTime: z.string().optional(),
    retry: z.number().int().optional(),
    steps: z.array(step).optional(),
    error: error.optional(),
    errors: z.array(error).optional(),
    attachments: z.array(z.object({ name: z.string(), contentType: z.string(), path: z.string().optional() })).optional(),
  })
  .passthrough();
type Test = { expectedStatus?: string; results: unknown[] };
type Spec = { file?: string; tests: Test[] };
type Suite = { specs?: Spec[]; suites?: Suite[] };

function read(directory: string) {
  try {
    const report = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
    const flatten = (suites: Suite[]): Spec[] => suites.flatMap((s) => [...(s.specs ?? []), ...flatten(s.suites ?? [])]);
    const tests = flatten(report.suites).flatMap((spec) => spec.tests.map((test) => ({ spec, test })));
    // Count tests as well as attempts: a second test with zero results is partial evidence.
    if (tests.length !== 1 || tests[0].test.results.length !== 1) return;
    const result = resultSchema.parse(tests[0].test.results[0]);
    const failed = (steps: Step[]): string | undefined => {
      for (const s of steps) {
        if (s.error) return s.title;
        const nested = failed(s.steps ?? []);
        if (nested) return nested;
      }
    };
    return { report, ...tests[0], result: { ...result, failedStep: failed(result.steps ?? []) } };
  } catch {
    return;
  }
}

export function readTestResult(directory: string) {
  return read(directory)?.result;
}

// Only a normally completed, single test with no retries or runner errors is reusable.
// An ordinary assertion failure exits 1 and is valid evidence; a timeout/interruption is not.
export function readCompletedTestResult(directory: string, code: number) {
  const parsed = read(directory);
  if (!parsed) return;
  const { result, report, test, spec } = parsed;
  const stats = report.stats;
  const passed = result.status === 'passed';
  if (
    (!passed && result.status !== 'failed') ||
    code !== (passed ? 0 : 1) ||
    test.expectedStatus !== 'passed' ||
    result.retry !== 0 ||
    result.duration === undefined ||
    !Array.isArray(result.errors) ||
    result.errors.length !== (passed ? 0 : 1) ||
    !Number.isFinite(Date.parse(result.startTime ?? '')) ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0 ||
    !stats ||
    !Number.isFinite(Date.parse(stats.startTime)) ||
    !Number.isFinite(stats.duration) ||
    stats.duration < 0 ||
    stats.expected !== (passed ? 1 : 0) ||
    stats.unexpected !== (passed ? 0 : 1) ||
    stats.skipped !== 0 ||
    stats.flaky !== 0 ||
    stats.duration < result.duration ||
    Date.parse(stats.startTime) > Date.parse(result.startTime ?? '') ||
    Date.parse(result.startTime ?? '') + result.duration > Date.parse(stats.startTime) + stats.duration + 1000 ||
    (passed ? !!result.error || !!result.errors?.length : !result.error?.message) ||
    typeof report.config?.rootDir !== 'string' ||
    typeof report.config?.configFile !== 'string' ||
    typeof spec.file !== 'string'
  )
    return;
  return {
    result,
    specPath: resolve(report.config.rootDir, spec.file),
    configPath: resolve(report.config.configFile),
    startedAt: stats.startTime as string,
    durationMs: stats.duration as number,
  };
}
