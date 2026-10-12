import { expect, test } from '@playwright/test';
import { openPage, qaseStep } from '../../qase-step';

test('DEMO-6914: Task List - Status filter retains tasks after Select all minus two statuses', { annotation: { type: 'qase', description: 'DEMO-6914' } }, async ({ page }) => {
  const rows = page.locator('.ag-center-cols-container .ag-row');
  const statusCells = rows.locator('[col-id=status]');
  const knownRow = rows.filter({ has: page.locator('[col-id=task_name]').getByText('Test,', { exact: true }) });
  const total = async () => {
    const text = await page.getByText(/\d+ to \d+ of [\d,]+/).first().innerText();
    return Number(text.match(/of ([\d,]+)/)![1].replace(/,/g, ''));
  };
  const openStatusFilter = async () => {
    const header = page.locator('.ag-header-cell[col-id=status]');
    await header.hover();
    await header.locator('.ag-header-cell-filter-button').click();
  };
  let filteredTotal = 0;

  await qaseStep(page, 1, 'Open Tasks view with known task visible', async () => {
    await openPage(page, '/tasks');
    await expect(rows.first()).toBeVisible();
    // inferred: the case names no task, so the known task "Test," (Stuck) was picked from the visible rows
    await expect(knownRow.first()).toBeVisible();
    await expect(knownRow.first().locator('[col-id=status]')).toContainText('Stuck');
  });

  await qaseStep(page, 2, 'Status filter: Select all', async () => {
    await openStatusFilter();
    await page.getByRole('checkbox', { name: 'Select all items' }).click();
    await expect(page.getByRole('checkbox', { name: 'Select all items' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Canceled' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Done' })).toBeChecked();
    await expect(rows.first()).toBeVisible();
  });

  await qaseStep(page, 3, 'Deselect Canceled and Done, apply', async () => {
    await page.getByRole('checkbox', { name: 'Canceled' }).click();
    await page.getByRole('checkbox', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(knownRow.first()).toBeVisible();
    // inferred: only the visible page is checked for absence of the deselected statuses
    await expect(statusCells.first()).toBeVisible();
    await expect(statusCells.filter({ hasText: /^\s*(Done|Canceled)\s*$/ })).toHaveCount(0);
    filteredTotal = await total();
  });

  await qaseStep(page, 4, 'Reset the Status filter', async () => {
    await openStatusFilter();
    await page.getByRole('button', { name: 'Reset' }).click();
    for (const name of ['Select all items', 'Canceled', 'Done', 'Stuck']) {
      await expect(page.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
    }
    // inferred: a larger total than the filtered one implies the Done/Canceled tasks are back
    await expect.poll(total).toBeGreaterThan(filteredTotal);
  });
});
