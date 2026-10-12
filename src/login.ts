import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { resolveRole } from './credentials.ts';

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

const main = async () => {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://localhost:4001' },
      role: { type: 'string', default: 'eugene' },
      slot: { type: 'string', default: '1' },
      headed: { type: 'boolean', default: false },
    },
  });
  const { base, role, slot, headed } = values;
  const creds = await resolveRole(role!);
  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/login`);
    await page.getByPlaceholder('Email').fill(creds.username);
    await page.getByPlaceholder('Password').fill(creds.password);
    await page.getByRole('button', { name: 'Login' }).click();

    const outcome = await Promise.any([
      page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }).then(() => 'in' as const),
      page.getByPlaceholder('Verification code').waitFor({ timeout: 30_000 }).then(() => 'mfa' as const),
    ]);
    if (outcome === 'mfa') {
      if (!creds.totp) throw new Error(`Role "${role}" requires MFA but has no totp reference`);
      await page.getByPlaceholder('Verification code').fill(await creds.totp());
      await page.getByRole('button', { name: 'Verify' }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    }
    // Redux persists the session to IndexedDB asynchronously after the redirect.
    await page.waitForFunction(async () => (await indexedDB.databases()).some((d) => d.name === 'localforage'));
    await page.waitForTimeout(1_000);
    await markTwoFactorModalSeen(page);

    const path = statePath(slot!, role!);
    mkdirSync(new URL('../.state/', import.meta.url), { recursive: true });
    await page.context().storageState({ path, indexedDB: true });
    console.log(`Logged in as role "${role}" on ${base}; state saved to ${path}`);
  } catch (error) {
    mkdirSync(new URL('../.state/', import.meta.url), { recursive: true });
    await page.screenshot({ path: new URL('../.state/login-failure.png', import.meta.url).pathname }).catch(() => {});
    console.error(`Login failed at ${page.url()}. Screenshot: .state/login-failure.png`);
    throw error;
  } finally {
    await browser.close();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
