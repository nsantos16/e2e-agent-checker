import { Effect } from 'effect';
import { attempt, OperationError, runEffect, sdk } from './runtime/effect.ts';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { childEnvironment, type TestUser } from './environments.ts';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { CredentialStoreLive, resolveRoleEffect, resolveTestUserEffect } from './credentials.ts';

// Logs a role into one slot's origin and saves storageState (including IndexedDB) for the agent's browser.
// Mirrors sample-frontend/tests/setup/index.setup.e2e.ts so the app sees the same state as its own e2e suite.

export const statePath = (slot: string, role: string) => new URL(`../.state/slot${slot}-${role}.json`, import.meta.url).pathname;

const markTwoFactorModalSeen = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('localforage');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const store = open.result.transaction('keyvaluepairs', 'readwrite').objectStore('keyvaluepairs');
          const get = store.get('persist:root');
          get.onsuccess = () => {
            const raw = get.result;
            const root = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const userResults = typeof root.userResults === 'string' ? JSON.parse(root.userResults) : root.userResults;
            const updated = { ...userResults, hasSeen2FAModal: true };
            root.userResults = typeof root.userResults === 'string' ? JSON.stringify(updated) : updated;
            const value = typeof raw === 'string' ? JSON.stringify(root) : root;
            store.put(value, 'persist:root').onsuccess = () => {
              localStorage.setItem('reduxStore', JSON.stringify(root));
              resolve();
            };
          };
          get.onerror = () => reject(get.error);
        };
      }),
  );

export type LoginOptions = {
  base: string;
  role: string;
  slot: string;
  headed?: boolean;
  signal?: AbortSignal;
  user?: TestUser;
  storageState?: string;
};
export const loginSlotEffect = ({ base, role, slot, headed = false, user, storageState }: LoginOptions) =>
  Effect.gen(function* () {
    const creds = yield* user ? resolveTestUserEffect(user) : resolveRoleEffect(role);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Effect.acquireRelease(
          sdk(() => chromium.launch({ headless: !headed, env: childEnvironment() as Record<string, string> })),
          (browser) => sdk(() => browser.close()).pipe(Effect.orDie),
        );
        const page = yield* sdk(() => browser.newPage());
        yield* sdk(() => page.goto(`${base}/login`));
        yield* sdk(() => page.getByPlaceholder('Email').fill(creds.username));
        yield* sdk(() => page.getByPlaceholder('Password').fill(creds.password));
        yield* sdk(() => page.getByRole('button', { name: 'Login' }).click());
        const outcome = yield* Effect.race(
          sdk(() => page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })).pipe(Effect.as('in' as const)),
          sdk(() => page.getByPlaceholder('Verification code').waitFor({ timeout: 30_000 })).pipe(Effect.as('mfa' as const)),
        );
        if (outcome === 'mfa') {
          if (!creds.totp) return yield* Effect.fail(new Error('Missing MFA reference'));
          const code = yield* sdk((signal) => creds.totp!(signal));
          yield* sdk(() => page.getByPlaceholder('Verification code').fill(code));
          yield* sdk(() => page.getByRole('button', { name: 'Verify' }).click());
          yield* sdk(() => page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }));
        }
        yield* sdk(() => page.waitForFunction(async () => (await indexedDB.databases()).some((d) => d.name === 'localforage')));
        yield* Effect.sleep(1000);
        yield* sdk(() => markTwoFactorModalSeen(page));
        const path = storageState ?? statePath(slot, role);
        yield* attempt(() => mkdirSync(dirname(path), { recursive: true, mode: 0o700 }));
        yield* sdk(() => page.context().storageState({ path, indexedDB: true }));
        yield* attempt(() => chmodSync(path, 0o600));
        return path;
      }),
    ).pipe(
      Effect.mapError(
        () =>
          new OperationError({ code: 'LOGIN_FAILED', message: 'Test-user login failed. Check the configured credentials and login flow.' }),
      ),
    );
  });
export const loginSlot = (opts: LoginOptions) => runEffect(loginSlotEffect(opts).pipe(Effect.provide(CredentialStoreLive)), opts.signal);

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://localhost:4001' },
      role: { type: 'string', default: 'eugene' },
      slot: { type: 'string', default: '1' },
      headed: { type: 'boolean', default: false },
    },
  });
  const path = await loginSlot({ base: values.base!, role: values.role!, slot: values.slot!, headed: values.headed });
  console.log(`Logged in as role "${values.role}" on ${values.base}; state saved to ${path}`);
}
