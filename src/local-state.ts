import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export const stateDirectory = () =>
  process.env.E2E_STATE_DIR ??
  (process.env.E2E_JOBS_PATH ? dirname(process.env.E2E_JOBS_PATH) : new URL('../.state', import.meta.url).pathname);
export const stateFile = (name: string) => join(stateDirectory(), name);
export const readState = <T>(file: string, fallback: T): T => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
export function writeState(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
