import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { digest, fail, stateFile, writeState } from './local-state.ts';
import type { SpeechResult } from './speech.ts';
import type { TextResult } from './narration-text.ts';

const inflight = new Map<string, Promise<unknown>>();
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
// An atomic exclusive receipt prevents double billing across concurrent callers and server restarts.
// A started request with no saved result is uncertain and is never automatically sent again.
async function cached<T>(
  kind: string,
  content: unknown,
  read: (dir: string) => T | undefined,
  write: (dir: string, result: T) => void,
  generate: (dir: string) => Promise<T>,
  signal?: AbortSignal,
) {
  const dir = stateFile(join('narration-cache', kind, digest({ version: 1, content })));
  mkdirSync(dir, { recursive: true });
  const found = read(dir);
  if (found) return { result: found, hit: true };
  const pending = inflight.get(dir);
  if (pending) return { result: (await waitFor(pending, signal)) as T, hit: true };
  try {
    writeFileSync(join(dir, 'attempt.json'), JSON.stringify({ startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('NARRATION_UNCERTAIN', 'An earlier identical request has no saved result');
    throw e;
  }
  const promise = Promise.resolve()
    .then(() => generate(dir))
    .then((result) => {
      write(dir, result);
      return result;
    })
    .catch((error) => {
      if (error?.beforeGeneration === true) rmSync(join(dir, 'attempt.json'), { force: true });
      throw error;
    });
  inflight.set(dir, promise);
  try {
    return { result: await promise, hit: false };
  } finally {
    inflight.delete(dir);
  }
}
export const cachedText = (content: unknown, generate: (dir: string) => Promise<TextResult>, signal?: AbortSignal) =>
  cached(
    'text',
    content,
    (dir) =>
      existsSync(join(dir, 'result.json')) ? (JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as TextResult) : undefined,
    (dir, result) => writeState(join(dir, 'result.json'), result),
    generate,
    signal,
  );
export const cachedSpeech = (content: unknown, generate: () => Promise<SpeechResult>, signal?: AbortSignal) =>
  cached(
    'speech',
    content,
    (dir) =>
      existsSync(join(dir, 'result.json')) && existsSync(join(dir, 'audio.pcm'))
        ? ({
            ...JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')),
            pcm: readFileSync(join(dir, 'audio.pcm')),
          } as SpeechResult)
        : undefined,
    (dir, { pcm, ...result }) => {
      writeFileSync(join(dir, 'audio.pcm'), pcm, { mode: 0o600 });
      writeState(join(dir, 'result.json'), result);
    },
    generate,
    signal,
  );
