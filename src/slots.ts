import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loginSlot, statePath } from './login.ts';

// A slot is one frontend worktree served on its own port against the shared dev API (docs/adr/0003).
// Dev servers run detached with a pid file so they outlive the process that started them.

export type Slot = { slot: string; worktree: string; port: number; role: string };

const root = new URL('..', import.meta.url).pathname;
const stateDir = join(root, '.state');
const registryPath = join(stateDir, 'slots.json');

export const baseUrl = (s: Pick<Slot, 'port'>) => `http://localhost:${s.port}`;
export const portFor = (slot: string) => 4000 + Number(slot);

const readRegistry = (): Record<string, Slot & { pid?: number }> =>
  existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : {};
const writeRegistry = (r: Record<string, Slot & { pid?: number }>) => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(registryPath, JSON.stringify(r, null, 2));
};

export const getSlot = (slot: string) => readRegistry()[slot];
export const listSlots = () => Object.values(readRegistry());

const isAlive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const isHealthy = async (s: Pick<Slot, 'port'>) => {
  try {
    const res = await fetch(baseUrl(s), { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
};

export const startSlot = async (slot: string, worktree: string, role = 'eugene') => {
  const port = portFor(slot);
  const registry = readRegistry();
  const existing = registry[slot];
  if (existing && isAlive(existing.pid) && existing.worktree === worktree && (await isHealthy(existing))) return existing;
  if (existing?.pid && isAlive(existing.pid)) process.kill(-existing.pid, 'SIGTERM');

  const logPath = join(stateDir, `slot${slot}-dev.log`);
  mkdirSync(stateDir, { recursive: true });
  const out = openSync(logPath, 'w');
  const child = spawn('npx', ['vp', 'dev', '--mode', 'ci.development', '--port', String(port), '--strictPort', '--open', 'false'], {
    cwd: worktree,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
  });
  child.unref();
  closeSync(out);

  const entry = { slot, worktree, port, role, pid: child.pid };
  registry[slot] = entry;
  writeRegistry(registry);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isHealthy(entry)) {
      // The first request triggers Vite's dependency optimisation; warm the main route so the agent doesn't pay for it.
      await fetch(`${baseUrl(entry)}/client-list`).catch(() => {});
      return entry;
    }
    if (!isAlive(child.pid)) throw new Error(`Slot ${slot} dev server exited. See ${logPath}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Slot ${slot} not healthy on port ${port} after 120s. See ${logPath}`);
};

export const stopSlot = (slot: string) => {
  const registry = readRegistry();
  const entry = registry[slot];
  if (entry?.pid && isAlive(entry.pid)) process.kill(-entry.pid, 'SIGTERM');
  delete registry[slot];
  writeRegistry(registry);
};

const MAX_SLOTS = 8;
const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// A worktree without node_modules shares the main checkout's only when the lockfiles match; otherwise it needs its own install.
const ensureNodeModules = (worktree: string) => {
  if (existsSync(join(worktree, 'node_modules'))) return;
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree, encoding: 'utf8' }).trim();
  const mainCheckout = resolve(commonDir, '..');
  const same = readFileSync(join(worktree, 'yarn.lock'), 'utf8') === readFileSync(join(mainCheckout, 'yarn.lock'), 'utf8');
  if (!same) throw new Error(`${worktree} has no node_modules and its yarn.lock differs from ${mainCheckout}. Run: (cd ${worktree} && yarn install --frozen-lockfile --ignore-engines --ignore-scripts)`);
  symlinkSync(join(mainCheckout, 'node_modules'), join(worktree, 'node_modules'));
};

// Concurrent jobs for the same worktree share one in-flight allocation instead of racing for two slots.
const allocating = new Map<string, Promise<Slot>>();

export const ensureSlotForWorktree = (worktreePath: string, role = 'eugene', log: (l: string) => void = () => {}) => {
  const key = `${resolve(worktreePath)}|${role}`;
  const inFlight = allocating.get(key);
  if (inFlight) return inFlight;
  const p = allocateSlot(worktreePath, role, log).finally(() => allocating.delete(key));
  allocating.set(key, p);
  return p;
};

// Finds the slot already serving this worktree, or allocates the next free one; starts it and logs the role in when needed.
const allocateSlot = async (worktreePath: string, role: string, log: (l: string) => void): Promise<Slot> => {
  const worktree = resolve(worktreePath);
  if (!existsSync(join(worktree, 'package.json'))) throw new Error(`${worktree} is not a frontend checkout (no package.json)`);
  const registry = readRegistry();
  const existing = Object.values(registry).find((s) => s.worktree === worktree);
  const slot = existing?.slot ?? String(Array.from({ length: MAX_SLOTS }, (_, i) => i + 1).find((n) => !registry[String(n)]) ?? '');
  if (!slot) throw new Error(`All ${MAX_SLOTS} slots are in use`);
  ensureNodeModules(worktree);
  log(`slot ${slot}: starting dev server for ${worktree}`);
  const entry = await startSlot(slot, worktree, role);
  const state = statePath(slot, role);
  if (!existsSync(state) || Date.now() - statSync(state).mtimeMs > SESSION_MAX_AGE_MS) {
    log(`slot ${slot}: logging in as ${role}`);
    await loginSlot({ base: baseUrl(entry), role, slot });
  }
  return entry;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { slot: { type: 'string' }, worktree: { type: 'string' }, role: { type: 'string', default: 'eugene' } },
  });
  const [command] = positionals;
  if (command === 'start') {
    if (!values.slot || !values.worktree) throw new Error('Usage: slots.ts start --slot <n> --worktree <path>');
    const s = await startSlot(values.slot, values.worktree, values.role);
    console.log(`Slot ${s.slot}: ${baseUrl(s)} ← ${s.worktree} (pid ${s.pid})`);
  } else if (command === 'stop') {
    stopSlot(values.slot!);
    console.log(`Slot ${values.slot} stopped`);
  } else {
    for (const s of listSlots()) console.log(`Slot ${s.slot}: ${baseUrl(s)} ← ${s.worktree} · pid ${s.pid} · ${isAlive(s.pid) && (await isHealthy(s)) ? 'up' : 'down'}`);
  }
}
