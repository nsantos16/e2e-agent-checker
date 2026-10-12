import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Team defaults live in e2e-agent.config.json (committed); each dev can override in e2e-agent.local.json (gitignored)
// or with environment variables. Nothing here is a secret.

type Config = {
  frontendRepo?: string;
  frontendRepoCandidates: string[];
  onePasswordAccount: string;
  qase: { project: string; mcpPackage: string; tokenEnv: string; keychainService: string };
  app: { port: number; maxParallel: number; maxPerWorktree: number };
  model: string;
  ffmpeg: string;
};

const root = new URL('..', import.meta.url).pathname;
const read = (file: string) => (existsSync(join(root, file)) ? JSON.parse(readFileSync(join(root, file), 'utf8')) : {});
const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge((a[k] as Record<string, unknown>) ?? {}, v as Record<string, unknown>) : v;
  return out;
};

const base = merge(read('e2e-agent.config.json'), read('e2e-agent.local.json')) as Config;
const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

export const config = {
  ...base,
  model: process.env.E2E_MODEL ?? base.model,
  ffmpeg: process.env.E2E_FFMPEG ?? base.ffmpeg,
  app: {
    port: Number(process.env.E2E_APP_PORT ?? base.app.port),
    maxParallel: Number(process.env.E2E_MAX_PARALLEL ?? base.app.maxParallel),
    maxPerWorktree: Number(process.env.E2E_MAX_PER_WORKTREE ?? base.app.maxPerWorktree),
  },
};

// The main frontend checkout: explicit setting first, then the usual clone locations.
export const frontendRepo = (): string | undefined => {
  const candidates = [process.env.E2E_FRONTEND_REPO, base.frontendRepo, ...base.frontendRepoCandidates].filter(Boolean).map((p) => expand(p!));
  return candidates.find((p) => existsSync(join(p, '.git')) && existsSync(join(p, 'package.json')));
};

export const requireFrontendRepo = () => {
  const repo = frontendRepo();
  if (!repo) throw new Error('sample-frontend checkout not found. Set "frontendRepo" in e2e-agent.local.json or E2E_FRONTEND_REPO.');
  return repo;
};

// Qase API token: environment first, then the macOS Keychain. It is passed only to the Qase MCP subprocess.
export const qaseToken = (): string | undefined => {
  if (process.env[config.qase.tokenEnv]) return process.env[config.qase.tokenEnv];
  if (process.platform !== 'darwin') return undefined;
  try {
    return execFileSync('security', ['find-generic-password', '-s', config.qase.keychainService, '-a', process.env.USER ?? '', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};
