import { expect, test } from '@playwright/test';
import { openPage, qaseStep } from '../../qase-step';

test('DEMO-3949: Comment Search - No results state displays correctly', { annotation: { type: 'qase', description: 'DEMO-3949' } }, async ({ page }) => {
  const query = 'zzz999xyz';
  const searchBox = page.getByRole('textbox', { name: 'Search comments...' });

  await qaseStep(page, 1, 'Open the Comments section', async () => {
    await openPage(page, '/client-list');
    // inferred: /practice/comments is not a searchable page; the notification inbox popover (bell badge, no label) is the comments section
    await page.getByRole('navigation').locator('span').filter({ hasText: /^\d+$/ }).first().click();
    await expect(searchBox).toBeVisible();
  });

  await qaseStep(page, 2, 'Search for a query with no results', async () => {
    await searchBox.fill(query);
    await searchBox.press('Enter');
    await expect(page.locator('[id^="timeline-element-"]')).toHaveCount(0);
  });

  await qaseStep(page, 3, 'No-results text shows the search query', async () => {
    await expect(page.getByText(`no results for "${query}"`)).toBeVisible();
  });

  await qaseStep(page, 4, 'Helper text is shown below the message', async () => {
    await expect(page.getByText('Try another search or clear the search to see all notifications')).toBeVisible();
  });
});
