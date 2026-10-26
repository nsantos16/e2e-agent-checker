import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { caseCompatibility, type TestCase } from './cases.ts';
import { environmentRequirements, type Environment, type TestUser } from './environments.ts';
import type { ExploreReport } from './explore.ts';
import { atomicJson } from './network.ts';

const root = new URL('..', import.meta.url).pathname;
const require = createRequire(import.meta.url);
export const runsRoot = () => process.env.E2E_RUNS_DIR ?? join(root, 'runs');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const caseSchema = z.object({ project: z.string(), id: z.number().int(), revision: z.string().min(1), sha256: digest }).strict();
const requirementsSchema = z
  .object({
    id: z.string(),
    revision: z.string(),
    kind: z.enum(['worktree', 'hosted']),
    devMode: z.string(),
    origin: z.string().optional(),
    userId: z.string(),
    credentialReferencesSha256: digest,
    application: z.string(),
  })
  .strict();
const runtimeSchema = z
  .object({
    contractVersion: z.literal(1),
    nodeMajor: z.string(),
    playwright: z.string(),
    playwrightTest: z.string(),
    browserSha256: digest,
    files: z.record(z.string(), digest),
  })
  .strict();
const buildSchema = z
  .object({
    capturedAt: z.string(),
    baseUrl: z.string(),
    worktree: z.string().optional(),
    buildId: z.string().optional(),
    commit: z.string().optional(),
    dirty: z.boolean().optional(),
    trackedDiffSha256: digest.optional(),
  })
  .strict();
export type BuildProvenance = z.infer<typeof buildSchema>;
export const savedSpecManifestSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string(),
    case: caseSchema,
    specContract: z.literal('relative-url-single-file-v1'),
    artifacts: z.object({ specSha256: digest, caseSha256: digest, reportSha256: digest }).strict(),
    runtime: runtimeSchema,
    requirements: requirementsSchema,
    // Deliberately excluded from compatibility comparisons.
    testedBuild: buildSchema,
  })
  .strict();
export type SavedSpecManifest = z.infer<typeof savedSpecManifestSchema>;
export type SpecSelection = {
  mode: 'reuse' | 'author' | 'replay';
  reason: string;
  sourceRun?: string;
  rejected?: { runDir: string; reason: string }[];
};
export type CompatibilityContext = {
  case: ReturnType<typeof caseCompatibility>;
  runtime: SavedSpecManifest['runtime'];
  requirements: SavedSpecManifest['requirements'];
};
export type SavedSpec = {
  runDir: string;
  manifest: SavedSpecManifest;
  spec: Buffer;
  caseBytes: Buffer;
  report: ExploreReport;
};
const git = (worktree: string, args: string[]) =>
  execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  }).trim();
export function captureBuild(baseUrl: string, worktree?: string, buildId?: string): BuildProvenance {
  const build: BuildProvenance = { capturedAt: new Date().toISOString(), baseUrl, worktree, buildId };
  if (worktree) {
    try {
      build.commit = git(worktree, ['rev-parse', 'HEAD']);
      build.dirty = !!git(worktree, ['status', '--porcelain']);
      if (build.dirty) build.trackedDiffSha256 = hash(git(worktree, ['diff', 'HEAD', '--']));
    } catch {
      /* A hosted build/non-git fixture has no inferred commit. */
    }
  }
  return build;
}
export function specRequirements(environment: Environment, user: TestUser, base: string, worktree?: string) {
  let application = new URL(base).origin;
  if (worktree) {
    try {
      application = realpathSync(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    } catch {
      application = resolve(worktree);
    }
  }
  return { ...environmentRequirements(environment, user, base), application: hash(application) };
}
export function specRuntime(): SavedSpecManifest['runtime'] {
  return {
    contractVersion: 1,
    nodeMajor: process.versions.node.split('.')[0],
    playwright: require('playwright/package.json').version,
    playwrightTest: require('@playwright/test/package.json').version,
    browserSha256: hash(readFileSync(join(require.resolve('playwright-core/package.json'), '..', 'browsers.json'))),
    files: Object.fromEntries(
      [
        'e2e/qase-step.ts',
        'e2e/playwright.config.ts',
        'src/browser-observer.ts',
        'src/network.ts',
        'src/replay.ts',
        'src/test-results.ts',
        'src/attempt-evidence.ts',
        'package-lock.json',
      ].map((file) => [file, hash(readFileSync(join(root, file)))]),
    ),
  };
}
export const compatibilityContext = (testCase: TestCase, requirements: SavedSpecManifest['requirements']): CompatibilityContext => ({
  case: caseCompatibility(testCase),
  runtime: specRuntime(),
  requirements,
});
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = Object.entries(a).filter(([, v]) => v !== undefined),
    right = Object.entries(b).filter(([, v]) => v !== undefined);
  return left.length === right.length && left.every(([k, v]) => Object.hasOwn(b, k) && equal(v, (b as Record<string, unknown>)[k]));
};
// Generated specs follow a deliberately small, relocatable contract. Unknown
// imports cannot be integrity-checked by this manifest, and literal origins can
// silently send a replay to an old worktree. Reject both conservatively.
export function specPortabilityReason(source: string): string | undefined {
  if (/['"`](?:https?:)?\/\//.test(source)) return 'spec-target-not-portable';
  if (/\b(?:import|require)\s*\(/.test(source)) return 'spec-dependency-unsupported';
  const imports = [...source.matchAll(/\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?['"]([^'"]+)['"]/g)];
  if (imports.some((m) => !['@playwright/test', '../../qase-step', '../../qase-step.ts'].includes(m[1])))
    return 'spec-dependency-unsupported';
}
export function compatibilityReason(manifest: SavedSpecManifest, context: CompatibilityContext): string | undefined {
  if (!equal(manifest.case, context.case)) return 'case-changed';
  if (!equal(manifest.runtime, context.runtime)) return 'runtime-changed';
  if (!equal(manifest.requirements, context.requirements)) return 'requirements-changed';
}
export const explorationReportPath = (runDir: string) => {
  const historical = join(runDir, 'historical/explore-report.json');
  return existsSync(historical) ? historical : join(runDir, 'explore/report.json');
};
export function readSavedSpec(runDir: string, context: CompatibilityContext): SavedSpec | string {
  const path = join(runDir, 'codify/manifest.json');
  if (!existsSync(path)) return 'manifest-missing';
  let manifest: SavedSpecManifest;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw?.version !== 1) return 'manifest-version-unsupported';
    manifest = savedSpecManifestSchema.parse(raw);
  } catch {
    return 'manifest-corrupt';
  }
  const reason = compatibilityReason(manifest, context);
  if (reason) return reason;
  try {
    // Read and validate once, then execute these bytes. No second read after queueing
    // or asynchronous preparation can swap in an unvalidated source artifact.
    const spec = readFileSync(join(runDir, 'codify', `${context.case.project}-${context.case.id}.spec.ts`));
    const caseBytes = readFileSync(join(runDir, 'explore/case.json'));
    const reportBytes = readFileSync(join(runDir, 'explore/report.json'));
    if (!equal(manifest.artifacts, { specSha256: hash(spec), caseSha256: hash(caseBytes), reportSha256: hash(reportBytes) }))
      return 'artifact-integrity-mismatch';
    const portability = specPortabilityReason(spec.toString());
    if (portability) return portability;
    if (!equal(caseCompatibility(JSON.parse(caseBytes.toString())), context.case)) return 'case-changed';
    const report: ExploreReport = JSON.parse(reportBytes.toString());
    if (report.caseId !== context.case.id || !Array.isArray(report.steps) || !['pass', 'fail', 'blocked'].includes(report.verdict))
      return 'artifact-corrupt';
    return { runDir, manifest, spec, caseBytes, report };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'artifact-missing' : 'artifact-corrupt';
  }
}
export function selectSavedSpec(
  context: CompatibilityContext,
  options: { forceFresh?: boolean; runDir?: string; directory?: string } = {},
) {
  if (options.forceFresh) return { decision: { mode: 'author', reason: 'force-fresh' } satisfies SpecSelection };
  const directory = options.directory ?? runsRoot();
  const rejected: NonNullable<SpecSelection['rejected']> = [];
  const specFile = `${context.case.project}-${context.case.id}.spec.ts`;
  const matchesCase = (dir: string) => {
    if (existsSync(join(dir, 'codify', specFile)) || basename(dir).includes(`-${context.case.project}-${context.case.id}-slot`))
      return true;
    try {
      const savedCase = JSON.parse(readFileSync(join(dir, 'codify/manifest.json'), 'utf8')).case;
      return savedCase?.project === context.case.project && savedCase?.id === context.case.id;
    } catch {
      return false;
    }
  };
  const publishedAt = (dir: string) => {
    try {
      return statSync(join(dir, 'codify/manifest.json')).mtimeMs;
    } catch {
      try {
        return statSync(dir).mtimeMs;
      } catch {
        return 0;
      } // Artifact cleanup may race discovery.
    }
  };
  const entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : [];
  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => join(directory, e.name))
    .filter((dir) => dir !== options.runDir && !existsSync(join(dir, 'historical/explore-report.json')) && matchesCase(dir))
    .sort((a, b) => publishedAt(b) - publishedAt(a) || b.localeCompare(a));
  for (const runDir of candidates) {
    const saved = readSavedSpec(runDir, context);
    if (typeof saved !== 'string')
      return {
        decision: { mode: 'reuse', reason: 'compatible', sourceRun: runDir, rejected: rejected.slice(0, 20) } satisfies SpecSelection,
        saved,
      };
    rejected.push({ runDir, reason: saved });
  }
  return {
    decision: { mode: 'author', reason: rejected[0]?.reason ?? 'no-saved-spec', rejected: rejected.slice(0, 20) } satisfies SpecSelection,
  };
}
export function publishSavedSpec(runDir: string, context: CompatibilityContext, testedBuild: BuildProvenance) {
  const manifest: SavedSpecManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    ...context,
    testedBuild,
    specContract: 'relative-url-single-file-v1',
    artifacts: {
      specSha256: hash(readFileSync(join(runDir, 'codify', `${context.case.project}-${context.case.id}.spec.ts`))),
      caseSha256: hash(readFileSync(join(runDir, 'explore/case.json'))),
      reportSha256: hash(readFileSync(join(runDir, 'explore/report.json'))),
    },
  };
  // The manifest is the publication marker. Never expose a partially written one.
  atomicJson(join(runDir, 'codify/manifest.json'), savedSpecManifestSchema.parse(manifest));
  return manifest;
}
