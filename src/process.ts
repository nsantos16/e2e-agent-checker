import { spawn } from 'node:child_process';
export const killTree = (pid?: number, signal: NodeJS.Signals = 'SIGTERM') => {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* already exited */
  }
};
export async function command(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onLine?: (line: string) => void;
    input?: string;
    timeoutMs?: number;
  } = {},
) {
  opts.signal?.throwIfAborted();
  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '',
    buffer = '';
  let timedOut = false;
  let force: NodeJS.Timeout | undefined;
  const abort = () => {
    killTree(child.pid);
    force = setTimeout(() => killTree(child.pid, 'SIGKILL'), 1500);
    force.unref();
  };
  opts.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => {
      timedOut = true;
      abort();
    },
    opts.timeoutMs ?? 30 * 60_000,
  );
  child.stdout.on('data', (d) => {
    stdout = (stdout + d).slice(-20 * 1024 * 1024);
    buffer += d;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      opts.onLine?.(line);
    }
  });
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(opts.input);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? -1));
    });
    if (buffer.trim()) opts.onLine?.(buffer);
    opts.signal?.throwIfAborted();
    if (timedOut) throw Object.assign(new Error('Command exceeded its time limit'), { code: 'TIMEOUT' });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', abort);
    // Include spawned browsers and shell grandchildren even when the parent exited first.
    killTree(child.pid);
    if (!force) {
      force = setTimeout(() => killTree(child.pid, 'SIGKILL'), 1500);
      force.unref();
    }
  }
}
