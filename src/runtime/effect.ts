import { Cause, Data, Effect, Exit } from 'effect';

export class OperationError extends Data.TaggedError('OperationError')<{
  code: string;
  message: string;
}> {}
export const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));
export const attempt = <A>(evaluate: () => A) => Effect.try({ try: evaluate, catch: asError });
// SDK boundary: Effect supplies cancellation; adapters must pass it to the underlying API.
export const sdk = <A>(evaluate: (signal: AbortSignal) => PromiseLike<A>) => Effect.tryPromise({ try: evaluate, catch: asError });

// Only Promise-facing entry points run effects. Preserve public error codes and abort reasons.
export async function runEffect<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  signal?.throwIfAborted();
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (Exit.hasInterrupts(exit) && signal?.aborted) throw signal.reason;
  throw Cause.squash(exit.cause);
}
export const deadline = <A, E, R>(effect: Effect.Effect<A, E, R>, ms: number, message = 'Operation exceeded its time limit') =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: ms,
      orElse: () => Effect.fail(new OperationError({ code: 'TIMEOUT', message })),
    }),
  );
