import { Effect } from 'effect';
import { attempt, deadline, runEffect, sdk } from '../runtime/effect.ts';
import { childEnvironment } from '../environments.ts';
import { spawn } from 'node:child_process';
import { killTree } from '../process.ts';

export class Rpc {
  child: ReturnType<typeof spawn>;
  pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
  next = 0;
  onEvent: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<any> = async () => {
    throw new Error('Tool not permitted');
  };
  closed: Promise<void>;
  failure?: Error;
  constructor(command: string, args: string[], cwd?: string) {
    this.child = spawn(command, args, { cwd, env: childEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stderr!.resume();
    this.child.stdin!.on('error', () => {});
    this.child.stdout!.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail(new Error('Invalid provider protocol message'));
        }
      }
    });
    this.closed = new Promise((resolve) => {
      this.child.once('error', (e) => {
        this.fail(e);
        resolve();
      });
      this.child.once('close', () => {
        this.fail(new Error('Provider disconnected'));
        resolve();
      });
    });
  }
  fail(e: Error) {
    this.failure = e;
    for (const p of this.pending.values()) {
      p.reject(e);
    }
    this.pending.clear();
  }
  send(value: unknown) {
    this.child.stdin!.write(JSON.stringify(value) + '\n');
  }
  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  requestEffect(method: string, params?: unknown, timeoutMs = 30_000) {
    return deadline(
      Effect.callback<any, Error>((resume) => {
        if (this.failure) {
          resume(Effect.fail(this.failure));
          return;
        }
        const id = ++this.next;
        this.pending.set(id, { resolve: (value) => resume(Effect.succeed(value)), reject: (error) => resume(Effect.fail(error)) });
        try {
          this.send({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          this.pending.delete(id);
          resume(Effect.fail(error instanceof Error ? error : new Error(String(error))));
        }
        return Effect.sync(() => {
          this.pending.delete(id);
        });
      }),
      timeoutMs,
      `TIMEOUT: ${method}`,
    );
  }
  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<any> {
    return runEffect(this.requestEffect(method, params, timeoutMs));
  }
  receive(m: any) {
    if (m.method && m.id !== undefined) {
      void this.onRequest(m.method, m.params).then(
        (result) => this.send({ jsonrpc: '2.0', id: m.id, result }),
        () => this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Tool not permitted' } }),
      );
    } else if (m.method) this.onEvent(m.method, m.params);
    else {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  }
  closeEffect() {
    return Effect.gen({ self: this }, function* () {
      killTree(this.child.pid);
      yield* sdk(() => this.closed).pipe(Effect.ignore, Effect.timeoutOption(1500));
      killTree(this.child.pid, 'SIGKILL');
    });
  }
  close() {
    return runEffect(this.closeEffect());
  }
}
export const codexConnectionEffect = (cwd?: string) =>
  Effect.gen(function* () {
    const rpc = yield* Effect.acquireRelease(
      attempt(() => new Rpc('codex', ['app-server'], cwd)),
      (rpc) => rpc.closeEffect(),
    );
    yield* rpc.requestEffect('initialize', {
      clientInfo: { name: 'e2e-agent-checker', version: '0.3.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    return rpc;
  });

export async function codexConnection(cwd?: string) {
  const rpc = new Rpc('codex', ['app-server'], cwd);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'e2e-agent-checker', version: '0.3.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    return rpc;
  } catch (e) {
    await rpc.close();
    throw e;
  }
}
