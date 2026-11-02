import type { Page } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { teamFixture } from './team-fixtures.ts';
import { seedTeamRuns } from './team-run-fixtures.ts';

export async function verifyRunsDashboard(
  page: Page,
  f: Awaited<ReturnType<typeof teamFixture>>,
  url: string,
) {
  const dashboard = page.getByRole('region', { name: 'Runs dashboard' });
  const list = page.getByRole('list', { name: 'Recent runs' });
  const rows = list.getByRole('listitem');
  await expect(
    dashboard.getByRole('heading', { name: 'Runs', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Run', exact: true }),
  ).toHaveCount(0);
  await expect(
    dashboard.getByText('No shared runs yet.', { exact: false }),
  ).toBeVisible();
  assert.equal(new URL(page.url()).pathname, '/');
  const fixtures = await seedTeamRuns(f);
  await dashboard.getByRole('button', { name: 'Refresh runs' }).click();
  await expect(rows).toHaveCount(25);
  await expect(dashboard.locator('dd').first()).toHaveText('31');
  await expect(rows.first()).toContainText('admin');
  await expect(rows.filter({ hasText: 'member (you)' })).not.toHaveCount(0);
  await page
    .getByLabel('Started by', { exact: true })
    .selectOption(f.users.get('member')!);
  await expect(rows).toHaveCount(25);
  await expect(dashboard.locator('dd').first()).toHaveText('28');
  await expect(rows.filter({ hasText: 'admin' })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Run pages' })
    .getByRole('link', { name: 'Next page' })
    .click();
  await expect(rows).toHaveCount(3);
  await page.reload();
  await expect(rows).toHaveCount(3);
  await expect(page.getByLabel('Started by', { exact: true })).toHaveValue(
    f.users.get('member')!,
  );
  assert.ok(new URL(page.url()).searchParams.has('runAfter'));
  const runLink = rows.first().getByRole('link');
  const runTitle = await runLink.innerText();
  await runLink.click();
  await expect(page.getByRole('article', { name: 'Run thread' })).toContainText(
    runTitle,
  );
  await expect(page.getByRole('article', { name: 'Run thread' })).toContainText(
    'member (you)',
  );
  await expect(page.locator('.thread-scroll .job-summary')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('article', { name: 'Run thread' })).toContainText(
    runTitle,
  );
  await page.getByRole('link', { name: 'Back to runs', exact: false }).click();
  await expect(rows).toHaveCount(3);
  await page
    .getByLabel('Started by', { exact: true })
    .selectOption(f.users.get('admin')!);
  await expect(rows).toHaveCount(3);
  assert.ok(
    !new URL(page.url()).searchParams.has('runAfter'),
    'changing user resets pagination',
  );
  await expect(dashboard.locator('dd').first()).toHaveText('3');
  await expect(rows.filter({ hasText: 'member' })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel('Started by', { exact: true })).toHaveValue(
    f.users.get('member')!,
  );
  await expect(rows).toHaveCount(3);
  await page
    .getByLabel('Started by', { exact: true })
    .selectOption(f.users.get('viewer')!);
  await expect(
    dashboard.getByText('No runs from this user yet.'),
  ).toBeVisible();
  await expect(dashboard.locator('dd').first()).toHaveText('0');
  await dashboard.getByRole('button', { name: 'Clear user filter' }).click();
  await expect(rows).toHaveCount(25);
  await dashboard.getByRole('button', { name: 'My runs', exact: true }).click();
  await expect(page.getByLabel('Started by', { exact: true })).toHaveValue(
    f.users.get('member')!,
  );
  // A failed refresh must be visible and recoverable without substituting another user's runs.
  await page.route('**/api/team/runs?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Temporary review outage' }),
    }),
  );
  await dashboard.getByRole('button', { name: 'Refresh runs' }).click();
  await expect(dashboard.getByRole('alert')).toContainText(
    'Temporary review outage',
  );
  await page.unroute('**/api/team/runs?**');
  await dashboard.getByRole('button', { name: 'Retry' }).click();
  await expect(dashboard.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Started by', { exact: true })).toBeVisible();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: 'runs/team-dashboard-mobile.png' });
  await page.getByLabel('Test identity').selectOption('viewer');
  await expect(rows).toHaveCount(25);
  await expect(rows.filter({ hasText: '(you)' })).toHaveCount(0);
  await dashboard.getByRole('button', { name: 'My runs', exact: true }).click();
  await expect(
    dashboard.getByText('No runs from this user yet.'),
  ).toBeVisible();
  await page.getByLabel('Test identity').selectOption('signed-out');
  await expect(page.getByRole('main')).toHaveCount(0);
  await page.getByLabel('Test identity').selectOption('member');
  await dashboard.getByRole('button', { name: 'Clear user filter' }).click();
  await expect(rows).toHaveCount(25);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'runs/team-dashboard-desktop.png' });
  const picked = fixtures.find((item) => item.token === 'admin')!;
  await page.goto(`${url}/runs/${picked.id}`);
  await expect(page.getByRole('article', { name: 'Run thread' })).toContainText(
    picked.title,
  );
  await page.goto(`${url}/runs/${randomUUID()}`);
  await expect(page.getByRole('alert')).toHaveText('Run not found.');
  await page.getByRole('button', { name: 'New verification' }).click();
  await expect(
    page.getByRole('heading', { name: 'What should we verify?' }),
  ).toBeVisible();
}
