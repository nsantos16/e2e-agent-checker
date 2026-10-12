import { expect, test } from '@playwright/test';
import { cleanup, openPage, qaseStep } from '../../qase-step';

test('DEMO-2359: Add new comment', { annotation: { type: 'qase', description: 'DEMO-2359' } }, async ({ page }) => {
  const text = `e2e-agent-${Date.now()}`;
  const commentText = page.getByText(text).first();

  try {
    await qaseStep(page, 1, 'Click on Comments', async () => {
      await openPage(page, '/clients/5670');
      await page.getByRole('link', { name: 'Comments' }).click();
      // inferred: the comments UI is a route-based panel rather than a modal
      await expect(page).toHaveURL(/\/clients\/5670\/comments/);
      await expect(page.getByTestId('add-comment-button')).toBeVisible();
    });

    await qaseStep(page, 2, 'Type a comment and click Comment', async () => {
      await page.getByTestId('add-comment-button').click();
      await page.getByTestId('comment-textarea').fill(text);
      // The UI shows the comment optimistically; wait for the save to finish so the reload doesn't abort it.
      const saved = page.waitForResponse((r) => r.url().includes('/add-pusher-comment') && r.ok(), { timeout: 30_000 });
      await page.getByTestId('comment-save-button').click();
      await saved;
      await expect(commentText).toBeVisible();
    });

    await qaseStep(page, 3, 'Refresh page', async () => {
      await page.reload();
      await expect(page).toHaveURL(/\/clients\/5670\/comments/);
      await expect(page.getByRole('img', { name: 'loading' })).toHaveCount(0, { timeout: 30_000 });
      await expect(commentText).toBeVisible({ timeout: 30_000 });
    });
  } finally {
    await cleanup(page, 'delete created comment', async () => {
      if (!page.url().includes('/comments')) await openPage(page, '/clients/5670/comments');
      await commentText.click();
      await page.getByTestId('comment-actions-menu').click();
      await page.getByTestId('comment-menu-delete').click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByText(text)).toHaveCount(0);
    });
  }
});
