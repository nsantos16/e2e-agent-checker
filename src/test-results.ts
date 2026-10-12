import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
type Result = { status: string; duration: number; steps?: { title: string; error?: unknown }[]; error?: { message?: string } };
type Suite = { specs?: { tests: { results: Result[] }[] }[]; suites?: Suite[] };
export function readTestResult(directory: string) {
  const path = join(directory, 'results.json');
  if (!existsSync(path)) return undefined;
  const report = JSON.parse(readFileSync(path, 'utf8')) as { suites: Suite[] };
  const flatten = (suites: Suite[]): Result[] =>
    suites.flatMap((s) => [...(s.specs ?? []).flatMap((spec) => spec.tests.flatMap((t) => t.results)), ...flatten(s.suites ?? [])]);
  const results = flatten(report.suites);
  // A verification artifact must contain exactly one test and no implicit retries.
  if (results.length !== 1) return undefined;
  const r = results[0];
  return { ...r, failedStep: r.steps?.find((s) => s.error)?.title };
}
