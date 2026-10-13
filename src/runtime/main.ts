import { Effect } from 'effect';
import { runEffect } from './effect.ts';

// Long-lived entry points own one scope. SIGINT/SIGTERM (and stdio EOF) wait for its finalizers.
export async function runMain<E>(program: Effect.Effect<unknown, E>, options: { stdin?: boolean } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Runtime stopped'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (options.stdin) process.stdin.once('end', stop);
  try {
    await runEffect(program, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (options.stdin) process.stdin.removeListener('end', stop);
  }
}
