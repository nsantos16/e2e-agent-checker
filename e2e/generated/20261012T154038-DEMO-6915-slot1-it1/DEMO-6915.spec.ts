import { expect, test, type Page } from '@playwright/test';
import { openPage, qaseStep } from '../../qase-step';

const NO_NAME = '(No Task Name)';
const NAMED = 'AI-QA 20248500ae0e92a1 R275 WMD-1965 C6915 named-alpha 20260923-1251';
const APOSTROPHE = "AI-QA 20248500ae0e92a1 R275 WMD-1965 C6915 O'Brien-beta 20260923-1251";

const taskNameCells = (page: Page) => page.locator('.ag-center-cols-container .ag-row [col-id="task_name"]');
const namedCells = (page: Page) => taskNameCells(page).filter({ hasText: /\S/ });
const paging = (page: Page) => page.locator('.ag-paging-panel');
const popup = (page: Page) => page.locator('.ag-popup');
const option = (page: Page, name: string) =>
  popup(page).locator('.ant-checkbox-wrapper').filter({ has: page.getByText(name, { exact: true }) });

const openFilter = async (page: Page) => {
  await page.locator('.ag-header-cell[col-id="task_name"] .ag-header-cell-filter-button').click();
  await expect(popup(page).getByRole('button', { name: 'OK' })).toBeVisible();
};

const toggleAndApply = async (page: Page, names: string[]) => {
  await openFilter(page);
  for (const name of names) {
    await option(page, name).click();
  }
  await popup(page).getByRole('button', { name: 'OK' }).click();
  await expect(popup(page)).toBeHidden();
};

test('DEMO-6915: Task List - Task Name filter combines unnamed and named tasks', { annotation: { type: 'qase', description: 'DEMO-6915' } }, async ({ page }) => {
  let unfilteredSummary = '';

  await qaseStep(page, 1, 'Open Tasks view with the Task Name filter cleared', async () => {
    await openPage(page, '/tasks');
    await expect(taskNameCells(page).first()).toBeVisible();
    unfilteredSummary = (await paging(page).innerText()).replace(/\s+/g, ' ').trim();
    // inferred: the unfiltered grid has thousands of rows, so presence of the noted tasks is checked through the
    // filter's value list, which holds every distinct task name plus the unnamed option.
    await openFilter(page);
    await expect(option(page, NO_NAME)).toBeVisible();
    await expect(option(page, NAMED)).toBeVisible();
    await expect(option(page, APOSTROPHE)).toBeVisible();
    await expect(popup(page).locator('.ant-checkbox-wrapper-checked')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(popup(page)).toBeHidden();
  });

  await qaseStep(page, 2, "Filter on '(No Task Name)' only", async () => {
    await toggleAndApply(page, [NO_NAME]);
    await expect(paging(page)).toContainText('22');
    await expect(namedCells(page)).toHaveCount(0);
    await expect(page.getByText(NAMED)).toHaveCount(0);
    await expect(page.getByText(APOSTROPHE)).toHaveCount(0);
  });

  await qaseStep(page, 3, "Add one named task to '(No Task Name)'", async () => {
    await toggleAndApply(page, [NAMED]);
    await expect(paging(page)).toContainText('23');
    await expect(namedCells(page)).toHaveText([NAMED]);
    await expect(page.getByText(APOSTROPHE)).toHaveCount(0);
  });

  await qaseStep(page, 4, 'Add the name containing an apostrophe', async () => {
    await toggleAndApply(page, [APOSTROPHE]);
    await expect(paging(page)).toContainText('24');
    await expect(namedCells(page)).toHaveText([NAMED, APOSTROPHE]);
    await expect(page.locator('.ant-message, .ant-notification, [role=alert]')).toHaveCount(0);
  });

  await qaseStep(page, 5, "Deselect '(No Task Name)', keep the two names", async () => {
    await toggleAndApply(page, [NO_NAME]);
    await expect(taskNameCells(page)).toHaveText([NAMED, APOSTROPHE]);
  });

  await qaseStep(page, 6, 'Clear the Task Name filter', async () => {
    await openFilter(page);
    await popup(page).getByRole('button', { name: 'Reset' }).click();
    const ok = popup(page).getByRole('button', { name: 'OK' });
    if (await ok.isVisible()) await ok.click();
    await expect(popup(page)).toBeHidden();
    await expect(paging(page)).toHaveText(unfilteredSummary);
  });
});
