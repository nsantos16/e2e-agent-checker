import { Context, Effect, Layer } from 'effect';
import { childEnvironment } from './environments.ts';
import { spawn } from 'node:child_process';
import { attempt, deadline, runEffect, sdk } from './runtime/effect.ts';

export const killTree = (pid?: number, signal: NodeJS.Signals = 'SIGTERM') => {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* already exited */
  }
};
export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  input?: string;
  timeoutMs?: number;
};
export type CommandResult = { code: number; stdout: string; stderr: string };
const execute = (name: string, args: string[], opts: CommandOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const task = yield* Effect.acquireRelease(
        attempt(() => {
          const child = spawn(name, args, {
            cwd: opts.cwd,
            env: childEnvironment(opts.env),
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '',
            stderr = '',
            buffer = '';
          let closed = false;
          const result = new Promise<CommandResult>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) => {
              closed = true;
              try {
                if (buffer.trim()) opts.onLine?.(buffer);
                resolve({ code: code ?? -1, stdout, stderr });
              } catch (error) {
                reject(error);
              }
            });
            child.stdout.on('data', (data) => {
              stdout = (stdout + data).slice(-20 * 1024 * 1024);
              buffer += data;
              let i: number;
              try {
                while ((i = buffer.indexOf('\n')) >= 0) {
                  const line = buffer.slice(0, i);
                  buffer = buffer.slice(i + 1);
                  opts.onLine?.(line);
                }
              } catch (error) {
                reject(error);
              }
            });
            child.stderr.on('data', (data) => {
              stderr = (stderr + data).slice(-4000);
            });
            child.stdin.on('error', () => {});
            child.stdin.end(opts.input);
          });
          // Attach immediately: spawn failures can arrive before the consumer resumes.
          void result.catch(() => {});
          return { child, result, isClosed: () => closed };
        }),
        (task) =>
          Effect.gen(function* () {
            killTree(task.child.pid);
            if (!task.isClosed()) yield* sdk(() => task.result).pipe(Effect.ignore, Effect.timeoutOption(1500));
            // Kill any remaining shell grandchildren even after the parent exited.
            killTree(task.child.pid, 'SIGKILL');
          }),
      );
      return yield* deadline(
        sdk(() => task.result),
        opts.timeoutMs ?? 30 * 60_000,
        'Command exceeded its time limit',
      );
    }),
  );

export class ProcessRunner extends Context.Service<ProcessRunner, { execute: typeof execute }>()('checker/ProcessRunner') {}
export const ProcessRunnerLive = Layer.succeed(ProcessRunner, { execute });
export const commandEffect = (name: string, args: string[], opts: CommandOptions = {}) =>
  Effect.flatMap(ProcessRunner, (service) => service.execute(name, args, opts));
export const command = (name: string, args: string[], opts: CommandOptions = {}) =>
  runEffect(commandEffect(name, args, opts).pipe(Effect.provide(ProcessRunnerLive)), opts.signal);
