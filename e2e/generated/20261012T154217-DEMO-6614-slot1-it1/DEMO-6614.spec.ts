import { expect, test } from '@playwright/test';
import { openPage, qaseStep } from '../../qase-step';

test('DEMO-6614: [Ledger Inspector] List filters persist in the URL', { annotation: { type: 'qase', description: 'DEMO-6614' } }, async ({ page }) => {
  // openPage waits for network idle on every navigation and this page keeps polling, so six navigations need headroom
  test.setTimeout(420_000);
  const provider = page.getByRole('combobox', { name: /Provider/ });
  const status = page.getByRole('combobox', { name: /Status/ });
  const pager = page.locator('li.ant-pagination-simple-pager');
  const pick = async (combobox: typeof provider, option: string) => {
    await combobox.click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };

  await qaseStep(page, 1, 'Set filters and go to a later page', async () => {
    await openPage(page, '/internal/ledger-inspector');
    await page.getByRole('textbox', { name: 'Search' }).fill('a');
    await pick(provider, 'QuickBooks');
    await pick(status, 'Error');
    await page.getByRole('spinbutton', { name: /Practice ID/ }).fill('1');
    // inferred: filters appear as URL params and the list reflects them; debounce timing is not asserted
    await expect(page).toHaveURL(/search=a/);
    await expect(page).toHaveURL(/provider=qbo/);
    await expect(page).toHaveURL(/status=error/);
    await expect(page).toHaveURL(/practiceId=1/);
    await expect(page.getByText('No clients match the active filters')).toBeVisible();

    await openPage(page, '/internal/ledger-inspector?provider=qbo&status=error&page=3');
    await expect(page).toHaveURL(/page=3/);
    await expect(provider).toHaveAccessibleName(/\bQuickBooks\b/);
    await expect(status).toHaveAccessibleName(/\bError\b/);
  });

  await qaseStep(page, 2, 'Refresh and open the same URL in a new tab', async () => {
    const url = page.url();
    await page.reload();
    const firstRow = page.getByText(/^#\d+ ·/).first();
    await expect(page).toHaveURL(url);
    await expect(provider).toHaveAccessibleName(/\bQuickBooks\b/);
    await expect(status).toHaveAccessibleName(/\bError\b/);
    await expect(pager.locator('input')).toHaveValue('3');
    await expect(firstRow).toBeVisible();
    const firstRowText = await firstRow.textContent();

    const tab = await page.context().newPage();
    try {
      await openPage(tab, url);
      await expect(tab.getByRole('combobox', { name: /Provider/ })).toHaveAccessibleName(/\bQuickBooks\b/);
      await expect(tab.getByRole('combobox', { name: /Status/ })).toHaveAccessibleName(/\bError\b/);
      await expect(tab.locator('li.ant-pagination-simple-pager input')).toHaveValue('3');
      await expect(tab.getByText(/^#\d+ ·/).first()).toHaveText(firstRowText!);
    } finally {
      await tab.close();
    }
  });

  await qaseStep(page, 3, 'Change Status on a later page returns to page 1', async () => {
    await pick(status, 'Synced');
    await expect(page).toHaveURL(/status=synced/);
    await expect(page).not.toHaveURL(/page=/);
    await expect(pager.locator('input')).toHaveValue('1');

    await page.locator('li[title="Next Page"] button').click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page).toHaveURL(/status=synced/);
    await page.locator('li[title="Next Page"] button').click();
    await expect(page).toHaveURL(/page=3/);
    await expect(page).toHaveURL(/provider=qbo/);
    await expect(page).toHaveURL(/status=synced/);
  });

  await qaseStep(page, 4, 'Open a client row, go Back, then Clear filters', async () => {
    await page.getByText(/^#\d+ ·/).first().click();
    // inferred: the filters carried in the detail URL are the filters still applied
    await expect(page).toHaveURL(/\/internal\/ledger-inspector\/\d+\?.*provider=qbo.*status=synced.*page=3/);

    await page.goBack();
    await expect(page).toHaveURL(/\/internal\/ledger-inspector\?provider=qbo&status=synced&page=3$/);
    await expect(pager.locator('input')).toHaveValue('3');

    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(page).toHaveURL(/\/internal\/ledger-inspector$/);
    await expect(provider).toHaveAccessibleName(/\bAll\b/);
    await expect(status).toHaveAccessibleName(/\bAll\b/);
    await expect(page.getByRole('textbox', { name: 'Search' })).toHaveValue('');
    await expect(page.getByRole('spinbutton', { name: /Practice ID/ })).toHaveValue('');
  });

  await qaseStep(page, 5, 'Legacy link redirects and keeps status=error', async () => {
    await openPage(page, '/ledger-inspector?status=error');
    await expect(page).toHaveURL(/\/internal\/ledger-inspector\?status=error$/);
    await expect(status).toHaveAccessibleName(/\bError\b/);
  });

  await qaseStep(page, 6, 'Malformed page and provider drop only themselves', async () => {
    await openPage(page, '/internal/ledger-inspector?status=error&search=sandbox&provider=foo&page=-1');
    await expect(page).toHaveURL(/\/internal\/ledger-inspector\?status=error&search=sandbox$/);
    await expect(provider).toHaveAccessibleName(/\bAll\b/);
    await expect(status).toHaveAccessibleName(/\bError\b/);
    await expect(page.getByRole('textbox', { name: 'Search' })).toHaveValue('sandbox');
    await expect(pager.locator('input')).toHaveValue('1');
  });
});
