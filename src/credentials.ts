import { Context, Effect, Layer } from 'effect';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import sdkClient from '@1password/sdk';
import type { TestUser } from './environments.ts';
import { config as appConfig } from './config.ts';
import { attempt, OperationError, runEffect, sdk } from './runtime/effect.ts';

export type Credentials = { username: string; password: string; totp?: (signal?: AbortSignal) => Promise<string> };
type Resolver = (ref: string, signal?: AbortSignal) => Promise<string>;
const opRead: Resolver = async (ref, signal) => {
  const { stdout } = await promisify(execFile)('op', ['read', '--no-newline', '--account', appConfig.onePasswordAccount, ref], {
    timeout: 60_000,
    signal,
  });
  return stdout;
};
// One desktop authorization per process, initialized lazily by the first op:// reference.
const resolver = Effect.runSync(
  Effect.cached(
    sdk(() =>
      sdkClient.createClient({
        auth: process.env.OP_SERVICE_ACCOUNT_TOKEN ?? new sdkClient.DesktopAuth(appConfig.onePasswordAccount),
        integrationName: 'e2e-agent-checker',
        integrationVersion: '0.0.1',
      }),
    ).pipe(
      Effect.map((client) => ((ref: string) => client.secrets.resolve(ref)) as Resolver),
      Effect.catch((error) => (process.env.OP_SERVICE_ACCOUNT_TOKEN ? Effect.fail(error) : Effect.succeed(opRead))),
    ),
  ),
);

const read = (ref: string) =>
  Effect.gen(function* () {
    if (ref.startsWith('env://')) {
      const value = process.env[ref.slice(6)];
      if (!value)
        return yield* Effect.fail(
          new OperationError({ code: 'CREDENTIAL_UNAVAILABLE', message: 'A configured credential environment variable is missing' }),
        );
      return value;
    }
    return yield* Effect.gen(function* () {
      const resolve = yield* resolver;
      return yield* sdk((signal) => resolve(ref, signal));
    }).pipe(
      Effect.mapError(
        () => new OperationError({ code: 'CREDENTIAL_UNAVAILABLE', message: 'Could not resolve a configured 1Password credential' }),
      ),
    );
  });
export class CredentialStore extends Context.Service<CredentialStore, { read: typeof read }>()('checker/CredentialStore') {}
export const CredentialStoreLive = Layer.succeed(CredentialStore, { read });
export const resolveTestUserEffect = (user: TestUser) =>
  Effect.gen(function* () {
    const store = yield* CredentialStore;
    const [username, password] = yield* Effect.all([store.read(user.usernameRef), store.read(user.passwordRef)], { concurrency: 2 });
    const totpRef = user.totpRef;
    return {
      username,
      password,
      ...(totpRef ? { totp: (signal?: AbortSignal) => runEffect(store.read(totpRef), signal) } : {}),
    } satisfies Credentials;
  });
export const resolveRoleEffect = (role: string) =>
  Effect.gen(function* () {
    const { roles } = yield* attempt(() => JSON.parse(readFileSync(new URL('../config/roles.json', import.meta.url), 'utf8')));
    const refs = roles[role];
    if (!refs) return yield* Effect.fail(new OperationError({ code: 'FIXTURE_UNAVAILABLE', message: `Unknown role "${role}"` }));
    return yield* resolveTestUserEffect({
      id: role,
      name: role,
      usernameRef: refs.username,
      passwordRef: refs.password,
      totpRef: refs.totp,
    });
  });
export const resolveRole = (role: string, signal?: AbortSignal): Promise<Credentials> =>
  runEffect(resolveRoleEffect(role).pipe(Effect.provide(CredentialStoreLive)), signal);
export const resolveTestUser = (user: TestUser, signal?: AbortSignal): Promise<Credentials> =>
  runEffect(resolveTestUserEffect(user).pipe(Effect.provide(CredentialStoreLive)), signal);
