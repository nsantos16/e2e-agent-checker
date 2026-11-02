import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { chromium, expect } from '@playwright/test';
import { teamFixture } from './team-fixtures.ts';
import { caseDraftSchema } from '../src/team/contracts.ts';
import { verifyRunsDashboard } from './team-runs-browser.ts';
import { createCase } from '../src/team/server/cases.ts';
import { resolveActor } from '../src/team/server/auth.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = root + '/dist/team-test';
await build({
  configFile: false,
  root: root + '/tests/team-ui',
  logLevel: 'warn',
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: root + '/src/team/client/routes',
      generatedRouteTree: root + '/src/team/client/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
  ],
  build: { outDir: output, emptyOutDir: true },
});
const f = await teamFixture({ staticRoot: output });
let browser;
let page;
const errors: string[] = [];
const unexpectedApi: string[] = [];
try {
  await f.initialize();
  const url = await f.app.listen({ host: '127.0.0.1', port: 0 });
  f.config.publicUrl = url;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/team/'))
      unexpectedApi.push(path);
  });
  await page.goto(url + '/');
  await verifyRunsDashboard(page, f, url);
  await expect(
    page.getByRole('heading', { name: 'What should we verify?' }),
  ).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Cases and run history' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New verification' }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Cases/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Runs/ })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Choose model' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Run', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('table')).toHaveCount(0);
  assert.equal(
    new URL(page.url()).pathname,
    '/cases',
    'new verification retains the thread',
  );
  await page.getByRole('link', { name: 'New case', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Team browser check');
  await page.getByLabel('Status', { exact: true }).selectOption('active');
  await page.getByRole('button', { name: 'Create case', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Active cases require',
  );
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Action 1', { exact: true }).fill('Open checkout');
  await page
    .getByLabel('Expected result 1', { exact: true })
    .fill('Order summary is visible');
  await page.getByRole('button', { name: 'Create case', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'New case', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Team browser check', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('link', { name: 'Team browser check', exact: true })
    .click();
  const id = new URL(page.url()).searchParams.get('caseId')!;
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    'Team browser check',
  );
  await page.getByLabel('Title', { exact: true }).fill('Saved browser edit');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('region', { name: 'Case details' })).toHaveCount(
    0,
  );
  await page
    .getByRole('link', { name: 'Saved browser edit', exact: true })
    .click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    'Saved browser edit',
  );
  await page.getByLabel('Title', { exact: true }).fill('Stale browser edit');
  const remote = await f.app.inject({
    method: 'PATCH',
    url: `/api/team/cases/${id}`,
    headers: { authorization: 'Bearer admin' },
    payload: {
      expectedRevision: 2,
      data: caseDraftSchema.parse({
        title: 'Teammate edit',
        status: 'active',
        steps: [
          {
            action: 'Open checkout',
            expectedResult: 'Order summary is visible',
          },
        ],
      }),
    },
  });
  assert.equal(remote.statusCode, 200);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Reload and reapply',
  );
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    'Stale browser edit',
  );
  await page.getByRole('button', { name: 'Reload latest version' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    'Teammate edit',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Search cases or runs').fill('no match');
  await page.getByLabel('Search cases or runs').press('Enter');
  await expect(
    page.getByText('No cases found. Adjust your search or create a case.'),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('link', { name: 'Teammate edit', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Test identity').selectOption('viewer');
  await page.reload();
  await expect(page.getByLabel('Test identity')).toHaveValue('viewer');
  await expect(
    page.getByRole('link', { name: 'New case', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Teammate edit', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toBeDisabled();
  await page.goto(url + '/cases?caseId=new');
  await expect(page.getByLabel('Test identity')).toHaveValue('viewer');
  await expect(page.getByLabel('Title', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Create case', exact: true }),
  ).toHaveCount(0);
  const bypass = await page.request.post(url + '/api/team/cases', {
    headers: { authorization: 'Bearer viewer' },
    data: { id: randomUUID(), data: { title: 'Forbidden' } },
  });
  assert.equal(bypass.status(), 403);
  // The fixture simulates an external Clerk identity change while a modal is open.
  await page
    .getByLabel('Test identity')
    .selectOption('signed-out', { force: true });
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await expect(page.getByRole('main')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0);
  await page.getByLabel('Test identity').selectOption('member');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Seed pagination through the same repository, without spending the browser's
  // HTTP rate limit on setup. Case writes through the UI are exercised above.
  const seedActor = await resolveActor(
    f.db,
    f.identities.get('member')!,
    f.config.clerkOrganizationId,
  );
  for (let i = 0; i < 27; i++) {
    await createCase(f.db, seedActor, {
      id: randomUUID(),
      data: caseDraftSchema.parse({
        title: `Page item ${String(i).padStart(2, '0')}`,
      }),
    });
  }
  await page.getByLabel('Search cases or runs').fill('Page item');
  await page.getByLabel('Search cases or runs').press('Enter');
  await expect(page.getByText('25 cases on this page')).toBeVisible();
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByText('2 cases on this page')).toBeVisible();
  await page.reload();
  await expect(page.getByText('2 cases on this page')).toBeVisible();
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page.getByText('25 cases on this page')).toBeVisible();
  await page.getByLabel('Search cases or runs').fill('Teammate edit');
  await page.getByLabel('Search cases or runs').press('Enter');
  await page.getByLabel('Select Teammate edit').check();
  await expect(page.locator('#case-summary')).toHaveText('Teammate edit');
  await expect(page.locator('#selection-preview')).toContainText(
    'Teammate edit',
  );
  await page.getByRole('link', { name: 'Teammate edit', exact: true }).click();
  const detailsUrl = page.url();
  await page.reload();
  await expect(
    page.getByRole('dialog', { name: 'Case details' }),
  ).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    'Teammate edit',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();
  await expect(
    page.getByRole('dialog', { name: 'Case details' }),
  ).toBeVisible();
  assert.equal(page.url(), detailsUrl);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New verification' }).click();
  await expect(page).toHaveURL(url + '/cases?search=');
  await expect(
    page.getByRole('heading', { name: 'What should we verify?' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Runs', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /^Cases/ }).click();
  const screenshotRoot = root + '/runs/team-thread-review';
  await mkdir(screenshotRoot, { recursive: true });
  await page.screenshot({ path: screenshotRoot + '/desktop.png' });
  await page.getByRole('button', { name: 'Switch color theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Switch color theme' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'Toggle sidebar' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Run', exact: true }),
  ).toBeVisible();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    'mobile layout must fit',
  );
  await page.screenshot({ path: screenshotRoot + '/mobile.png' });
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Account', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: screenshotRoot + '/account-mobile.png' });
  await expect(
    page.getByRole('heading', { name: 'Sign-in sessions' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Revoke session' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Revoke session' }).click();
  await expect(
    page.getByText('Signed out or loading identity', { exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  assert.deepEqual(
    unexpectedApi,
    [],
    'shared UI must not call local worker APIs',
  );
  assert.equal((await f.app.inject('/assets/missing.js')).statusCode, 404);
  assert.equal((await f.app.inject('/api/team/missing')).statusCode, 404);
  assert.equal((await f.app.inject('/account')).statusCode, 200);
  console.log(
    'Team browser flow passed: runs dashboard, trusted user attribution, user filtering, totals, paging/reload/history, run threads, empty/error states, mobile, original thread/sidebar/composer, themes, account dialog, API isolation, case edits, conflicts, read-only access, identity disposal and session revocation.',
  );
} catch (error) {
  console.error({
    errors,
    page: (await page?.locator('body').innerText())?.slice(0, 5000),
  });
  throw error;
} finally {
  await browser?.close();
  await f.close();
}
