import { expect, test } from '@playwright/test';
import { cleanup, openPage, qaseStep } from '../../qase-step';

test('DEMO-2359: Add new comment', { annotation: { type: 'qase', description: 'DEMO-2359' } }, async ({ page }) => {
  const commentText = `e2e-agent-${Date.now()}`;
  const comment = page.getByText(commentText);

  try {
    await qaseStep(page, 1, 'Click on Comments', async () => {
      await openPage(page, '/clients/5670');
      await page.getByRole('link', { name: 'Comments' }).click();
      // inferred: the app opens a comments page (not a modal) with an add-comment control
      await expect(page).toHaveURL(/\/clients\/5670\/comments/);
      await expect(page.getByTestId('add-comment-button').first()).toBeVisible();
    });

    await qaseStep(page, 2, 'Type a comment and click Comment', async () => {
      await page.getByTestId('add-comment-button').first().click();
      await page.getByTestId('comment-textarea').first().fill(commentText);
      const saved = page.waitForResponse((r) => r.url().includes('add-pusher-comment') && r.status() === 200);
      await page.getByTestId('comment-save-button').first().click();
      await saved;
      await expect(comment.first()).toBeVisible();
    });

    await qaseStep(page, 3, 'Refresh page', async () => {
      await page.reload();
      await page.getByRole('img', { name: 'loading' }).first().waitFor({ state: 'hidden' }).catch(() => {});
      await expect(page).toHaveURL(/\/clients\/5670\/comments/);
      await expect(comment).toHaveCount(1);
    });
  } finally {
    await cleanup(page, 'delete created comment', async () => {
      await comment.first().click({ timeout: 10_000 });
      await page.getByTestId('comment-actions-menu').click({ timeout: 5_000 });
      await page.getByTestId('comment-menu-delete').click({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: 5_000 });
      await expect(comment).toHaveCount(0, { timeout: 10_000 });
    });
  }
});
