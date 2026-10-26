import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from '@babel/parser';
import { unzipSync } from 'fflate';
import { atomicJson, readJson } from './network.ts';
import { baseUrl, getSlot } from './slots.ts';
import { childEnvironment, getEnvironment, getTestUser, testIdentityKey } from './environments.ts';
import { readCompletedTestResult, readTestResult } from './test-results.ts';

const root = new URL('..', import.meta.url).pathname;
export const hashFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const inside = (parent: string, path: string) => realpathSync(path).startsWith(realpathSync(parent) + '/');

export type EvidenceContext = {
  runDir: string;
  specPath: string;
  casePath: string;
  base: string;
  slot: string;
  role: string;
  storageState: string;
  environmentId?: string;
  environmentRevision?: string;
  userIdentity?: string;
};

// Hash every tracked and untracked source file, not just HEAD or `git diff`.
// Ignored Vite env files and dependency installation metadata also affect the build.
export function worktreeIdentity(worktree: string, mode: string) {
  const cwd = realpathSync(worktree);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const files = new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean));
  for (const name of [
    '.env',
    '.env.local',
    `.env.${mode}`,
    `.env.${mode}.local`,
    'node_modules/.package-lock.json',
    'node_modules/.yarn-integrity',
  ])
    files.add(name);
  const contents = [...files].sort().map((name) => {
    const path = join(cwd, name);
    if (!existsSync(path)) return [name, null];
    // Gitlinks and external source symlinks cannot be identified by this snapshot.
    if (!statSync(path).isFile() || (!name.startsWith('node_modules/') && !inside(cwd, path))) throw new Error('Unresolved build input');
    return [name, hashFile(path), statSync(path).mtimeMs];
  });
  return { worktree: cwd, head: git('rev-parse', 'HEAD').trim(), contentHash: hash(contents), mode };
}

function inputsIdentity(specPath: string, context: EvidenceContext) {
  const files = new Map<string, string>();
  const variables = new Set(['CI', 'TZ', 'NODE_OPTIONS', 'NODE_ENV']);
  const trusted = new Set(
    ['e2e/qase-step.ts', 'e2e/playwright.config.ts', 'src/browser-observer.ts', 'src/network.ts'].map((p) => resolve(root, p)),
  );
  const visit = (path: string) => {
    path = realpathSync(path);
    if (files.has(path)) return;
    const source = readFileSync(path, 'utf8');
    files.set(path, hashFile(path));
    const dependencies = new Set<string>();
    const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    const walk = (node: any, parent?: any) => {
      if (!node || typeof node !== 'object') return;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
        dependencies.add(node.source.value);
      if (node.type === 'ImportExpression') {
        if (node.source.type !== 'StringLiteral') throw new Error('Dynamic dependency');
        dependencies.add(node.source.value);
      }
      if (node.type === 'CallExpression' && (node.callee.type === 'Import' || node.callee.name === 'require')) {
        if (node.arguments.length !== 1 || node.arguments[0].type !== 'StringLiteral') throw new Error('Dynamic dependency');
        dependencies.add(node.arguments[0].value);
      }
      if (
        node.type === 'MemberExpression' &&
        node.object.name === 'process' &&
        (node.computed ? node.property.value : node.property.name) === 'env'
      ) {
        if (parent?.type !== 'MemberExpression' || parent.object !== node || (parent.computed && parent.property.type !== 'StringLiteral'))
          throw new Error('Dynamic environment input');
        variables.add(parent.computed ? parent.property.value : parent.property.name);
      }
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach((child) => walk(child, node));
        else if (value && typeof value === 'object') walk(value, node);
      }
    };
    walk(tree);
    for (const name of dependencies) {
      if (name === '@playwright/test' || name === 'playwright') continue;
      if (name.startsWith('node:') && trusted.has(path)) continue;
      if (!name.startsWith('.')) throw new Error('Unresolved helper dependency');
      const base = resolve(dirname(path), name);
      const found = [base, base + '.ts', base + '.js', join(base, 'index.ts')].find((p) => existsSync(p) && statSync(p).isFile());
      if (!found) throw new Error('Missing helper');
      visit(found);
    }
  };
  visit(specPath);
  visit(join(root, 'e2e/playwright.config.ts'));
  visit(join(root, 'e2e/qase-step.ts'));
  files.set(join(context.runDir, 'explore/report.json'), hashFile(join(context.runDir, 'explore/report.json')));
  for (const path of [
    'scripts/try-spec.sh',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'node_modules/@playwright/test/package.json',
    'node_modules/playwright/package.json',
    'node_modules/playwright-core/package.json',
    'node_modules/playwright-core/browsers.json',
  ])
    files.set(resolve(root, path), hashFile(join(root, path)));
  const env = childEnvironment();
  for (const name of Object.keys(env)) if (name.startsWith('PLAYWRIGHT_')) variables.add(name);
  // Artifact locations differ between executions. All behavioral inputs are explicit.
  for (const name of ['E2E_OUTPUT_DIR', 'E2E_OBSERVATION_RUN_DIR', 'E2E_SPEC_DIR']) variables.delete(name);
  Object.assign(env, { E2E_BASE_URL: context.base, E2E_STORAGE_STATE: context.storageState, E2E_SLOWMO: '0', E2E_CAPTIONS: '1' });
  return {
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))),
    environmentHash: hash([...variables].sort().map((name) => [name, env[name] ?? null])),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    recording: { captions: true, slowMo: 0 },
  };
}

const available = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

export function captureIdentity(context: EvidenceContext) {
  const slot = available(() => getSlot(context.slot));
  const environment = available(() => getEnvironment(context.environmentId ?? slot?.environmentId ?? 'local'));
  const user = environment && available(() => getTestUser(environment, context.role));
  // Retain the identities we can establish even when another input is unavailable.
  return {
    specHash: available(() => hashFile(context.specPath)),
    inputs: available(() => inputsIdentity(context.specPath, context)),
    case: available(() => {
      const testCase = readJson<{ revision?: string; project?: string; id?: number }>(context.casePath);
      if (!testCase?.revision || !testCase.project || !testCase.id) return null;
      return { project: testCase.project, id: testCase.id, revision: testCase.revision, hash: hashFile(context.casePath) };
    }),
    target: available(() => {
      // A URL alone is not a build ID. Hosted/missing/unmanaged builds replay normally.
      if (
        !slot?.pid ||
        !environment ||
        environment.kind !== 'worktree' ||
        new URL(context.base).origin !== baseUrl(slot) ||
        (slot.environmentId ?? 'local') !== environment.id ||
        (slot.devMode ?? 'ci.development') !== environment.devMode
      )
        return null;
      const processIdentity = execFileSync('ps', ['-p', String(slot.pid), '-o', 'lstart=', '-o', 'args='], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!processIdentity) return null;
      return {
        base: context.base,
        slot: context.slot,
        pid: slot.pid,
        serverHash: hash(processIdentity),
        ...worktreeIdentity(slot.worktree, environment.devMode),
      };
    }),
    environment:
      environment && (!context.environmentRevision || context.environmentRevision === environment.revision)
        ? { id: environment.id, revision: environment.revision, hash: hash(environment) }
        : null,
    user:
      (user &&
        (!context.userIdentity || context.userIdentity === testIdentityKey(user)) &&
        available(() => ({
          id: user.id,
          identity: testIdentityKey(user),
          storageState: realpathSync(context.storageState),
          sessionHash: hashFile(context.storageState),
        }))) ||
      null,
  };
}
export type ExecutionIdentity = NonNullable<ReturnType<typeof captureIdentity>>;
export type Artifact = { path: string; hash: string; bytes: number };
export type AttemptManifest = {
  version: 1;
  attemptId: string;
  attempts: number;
  runDir: string;
  specPath: string;
  artifactDir: string;
  manifestPath: string;
  state: 'running' | 'completed' | 'cancelled' | 'incomplete';
  specHash: string;
  identity: ExecutionIdentity | null;
  identityAfter: ExecutionIdentity | null;
  startedAt: string;
  completedAt?: string;
  executionMs?: number;
  code: number | null;
  result?: ReturnType<typeof readTestResult>;
  artifacts: Artifact[];
};

export function saveAttempt(manifest: AttemptManifest) {
  // Sidecars survive Playwright clearing its output directory. No mtime-based selection.
  atomicJson(manifest.manifestPath, manifest);
  atomicJson(join(manifest.runDir, 'codify/last-attempt.json'), manifest);
}

export function attemptArtifacts(directory: string): Artifact[] {
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error('Unexpected artifact symlink');
    }
  };
  walk(directory);
  paths.push(directory + '.log');
  return paths.sort().map((path) => ({ path, hash: hashFile(path), bytes: statSync(path).size }));
}

export type VerifiedAttempt = { manifestPath: string; outcome: 'passed' | 'failed-as-expected'; failingStep: number | null };
export type Eligibility =
  | { eligible: false; reason: string }
  | { eligible: true; manifest: AttemptManifest; video: string; trace: string; result: NonNullable<ReturnType<typeof readTestResult>> };

export function qualifyAttempt(context: EvidenceContext, verified: VerifiedAttempt): Eligibility {
  const reject = (reason: string): Eligibility => ({ eligible: false, reason });
  try {
    const manifest = readJson<AttemptManifest>(verified.manifestPath);
    const last = readJson<AttemptManifest>(join(context.runDir, 'codify/last-attempt.json'));
    const count = readJson<{ attempts: number }>(join(context.runDir, 'codify/attempts.json'));
    if (
      !manifest ||
      manifest.version !== 1 ||
      !Number.isSafeInteger(manifest.attempts) ||
      manifest.attempts < 1 ||
      manifest.attemptId !== basename(manifest.artifactDir) ||
      !same(last, manifest) ||
      manifest.attempts !== count?.attempts ||
      manifest.manifestPath !== verified.manifestPath ||
      manifest.runDir !== context.runDir ||
      manifest.specPath !== context.specPath ||
      !inside(join(context.runDir, 'codify/attempts'), manifest.artifactDir) ||
      manifest.manifestPath !== manifest.artifactDir + '.manifest.json'
    )
      return reject('missing-or-stale-manifest');
    if (
      manifest.state !== 'completed' ||
      !Number.isFinite(manifest.executionMs) ||
      manifest.executionMs! < 0 ||
      typeof manifest.startedAt !== 'string' ||
      typeof manifest.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(manifest.startedAt)) ||
      !Number.isFinite(Date.parse(manifest.completedAt ?? '')) ||
      Date.parse(manifest.completedAt!) < Date.parse(manifest.startedAt) ||
      Date.parse(manifest.completedAt!) > Date.now() ||
      Math.abs(manifest.executionMs! - (Date.parse(manifest.completedAt!) - Date.parse(manifest.startedAt))) > 1000 ||
      Date.now() - Date.parse(manifest.completedAt!) > 30 * 60_000
    )
      return reject('incomplete-attempt');
    const current = captureIdentity(context);
    if (
      !current.specHash ||
      !current.inputs ||
      !current.case ||
      !current.target ||
      !current.environment ||
      !current.user ||
      !manifest.identity ||
      !same(manifest.identity, manifest.identityAfter) ||
      !same(manifest.identity, current) ||
      manifest.specHash !== current.specHash
    )
      return reject('identity-unavailable-or-changed');
    const completed = readCompletedTestResult(manifest.artifactDir, manifest.code!);
    if (
      !completed ||
      completed.specPath !== context.specPath ||
      completed.configPath !== resolve(root, 'e2e/playwright.config.ts') ||
      !same(completed.result, manifest.result) ||
      Date.parse(completed.startedAt) < Date.parse(manifest.startedAt) ||
      Date.parse(completed.startedAt) + completed.durationMs > Date.parse(manifest.completedAt!) + 1000
    )
      return reject('invalid-result');
    const result = completed.result;
    if (
      verified.outcome === 'passed'
        ? result.status !== 'passed'
        : result.status !== 'failed' || !verified.failingStep || !result.failedStep?.startsWith(`Step ${verified.failingStep}:`)
    )
      return reject('unverified-outcome');
    const report = readJson<{ verdict: string; steps: { position: number; verdict: string }[] }>(
      join(context.runDir, 'explore/report.json'),
    );
    if (
      verified.outcome === 'passed'
        ? report?.verdict !== 'pass'
        : report?.verdict !== 'fail' ||
          !report.steps.some((s) => s.position === verified.failingStep && s.verdict === 'fail') ||
          !/expect\(/.test((result.error?.message ?? '').replace(/\x1b\[[0-9;]*m/g, ''))
    )
      return reject('unverified-product-outcome');
    // Compare the complete inventory, including screenshots, error context, network and log.
    if (!same(manifest.artifacts, attemptArtifacts(manifest.artifactDir))) return reject('missing-or-changed-artifacts');
    const attachments = result.attachments ?? [];
    const videos = attachments.filter((a) => a.name === 'video' && a.contentType === 'video/webm');
    const traces = attachments.filter((a) => a.name === 'trace' && a.contentType === 'application/zip');
    if (videos.length !== 1 || traces.length !== 1) return reject('ambiguous-or-missing-recording');
    const video = videos[0].path,
      trace = traces[0].path;
    for (const path of [video, trace, join(manifest.artifactDir, 'results.json'), join(manifest.artifactDir, 'network.json')])
      if (
        !path ||
        !inside(manifest.artifactDir, path) ||
        !manifest.artifacts.some((a) => a.path === path && a.bytes > 0) ||
        lstatSync(path).isSymbolicLink()
      )
        return reject('missing-recording-or-diagnostics');
    const network = readJson<{ version: number; requests: unknown[] }>(join(manifest.artifactDir, 'network.json'));
    if (network?.version !== 1 || !Array.isArray(network.requests)) return reject('malformed-diagnostics');
    // Validate the trace container and its event streams, not just its filename/header.
    const streams = Object.values(
      unzipSync(readFileSync(trace!), {
        filter: (file) => {
          if (file.originalSize > 128 * 1024 * 1024) throw new Error('Oversized trace entry');
          return file.name.endsWith('.trace');
        },
      }),
    );
    if (
      !streams.length ||
      streams.some((stream) => {
        const lines = Buffer.from(stream).toString('utf8').trim().split('\n');
        return lines.some((line) => typeof JSON.parse(line)?.type !== 'string');
      })
    )
      return reject('malformed-trace');
    // Video decoding during packaging rejects corrupt/truncated recordings.
    if (
      !readFileSync(video!)
        .subarray(0, 4)
        .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    )
      return reject('malformed-recording');
    return { eligible: true, manifest, result, video: video!, trace: trace! };
  } catch {
    return reject('missing-or-malformed-evidence');
  }
}
