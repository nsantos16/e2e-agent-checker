// Frozen openPage implementation from ba15ae4, for measured before/after comparisons only.
import { test, type Page } from '@playwright/test';

const warmed = new WeakSet<Page>();
export const legacyOpenPage = async (page: Page, url: string, home = '/client-list') => {
  const spinner = page.getByRole('img', { name: 'loading' }).first();
  const settled = async () => {
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    return spinner.waitFor({ state: 'hidden', timeout: 25_000 }).then(
      () => true,
      () => false,
    );
  };
  if (!warmed.has(page)) {
    await page.goto(home);
    await settled();
    warmed.add(page);
  }
  await page.goto(url);
  if (await settled()) return;
  test.info().annotations.push({ type: 'app-recovery', description: `${url} stalled on the loading spinner; reloading` });
  await page.reload();
  if (await settled()) return;
  throw new Error(`${url} never finished loading (spinner still visible after a warm start and a reload)`);
};
