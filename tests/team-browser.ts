import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { chromium, expect } from '@playwright/test';
import { teamFixture } from './team-fixtures.ts';
import { caseDraftSchema } from '../src/team/contracts.ts';

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
try {
  await f.initialize();
  const url = await f.app.listen({ host: '127.0.0.1', port: 0 });
  f.config.publicUrl = url;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url + '/cases');
  await page.getByRole('link', { name: 'New case', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Team browser check');
  await page.getByLabel('Status', { exact: true }).selectOption('active');
  await page.getByRole('button', { name: 'Create case', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Active cases require');
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
      data: caseDraftSchema.parse({ title: 'Teammate edit' }),
    },
  });
  assert.equal(remote.statusCode, 200);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('Reload and reapply');
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    'Stale browser edit',
  );
  await page.getByRole('button', { name: 'Reload latest version' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    'Teammate edit',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Find a case').fill('no match');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(
    page.getByText('No cases found. Create a case or adjust your search.'),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('link', { name: 'Teammate edit', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Test identity').selectOption('viewer');
  await expect(
    page.getByRole('link', { name: 'New case', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Teammate edit', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toBeDisabled();
  const bypass = await page.request.post(url + '/api/team/cases', {
    headers: { authorization: 'Bearer viewer' },
    data: { id: randomUUID(), data: { title: 'Forbidden' } },
  });
  assert.equal(bypass.status(), 403);
  await page.getByLabel('Test identity').selectOption('signed-out');
  await expect(
    page.getByRole('heading', { name: 'Cases', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0);
  await page.getByLabel('Test identity').selectOption('member');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  for (let i = 0; i < 27; i++) {
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/team/cases',
      headers: { authorization: 'Bearer member' },
      payload: {
        id: randomUUID(),
        data: { title: `Page item ${String(i).padStart(2, '0')}` },
      },
    });
    assert.equal(created.statusCode, 201);
  }
  await page.getByLabel('Find a case').fill('Page item');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('25 cases on this page')).toBeVisible();
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByText('2 cases on this page')).toBeVisible();
  await page.reload();
  await expect(page.getByText('2 cases on this page')).toBeVisible();
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page.getByText('25 cases on this page')).toBeVisible();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
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
  assert.equal((await f.app.inject('/assets/missing.js')).statusCode, 404);
  assert.equal((await f.app.inject('/api/team/missing')).statusCode, 404);
  assert.equal((await f.app.inject('/account')).statusCode, 200);
  console.log(
    'Team browser flow passed: create, validation, reload, edit, conflict, history, read-only access, identity disposal, pagination, session revocation and SPA fallback.',
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
