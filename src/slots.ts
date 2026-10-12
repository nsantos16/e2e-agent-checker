import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

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
