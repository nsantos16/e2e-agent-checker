import { expect, test } from '@playwright/test';
import { openPage, qaseStep } from '../../qase-step';

test(
  'DEMO-6611: [Internal Admin Dashboard] Allowlisted admin sees Internal tab and the Internal tools page',
  { annotation: { type: 'qase', description: 'DEMO-6611' } },
  async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Internal tools' });
    const denied = page.getByText('Access denied');

    await qaseStep(page, 1, 'Main nav shows an Internal tab', async () => {
      await openPage(page, '/client-list');
      await expect(page.getByRole('link', { name: 'Internal', exact: true })).toBeVisible();
    });

    await qaseStep(page, 2, 'Internal tools page loads', async () => {
      await openPage(page, '/internal');
      await expect(page).toHaveURL(/\/internal$/);
      await expect(heading).toBeVisible();
      await expect(denied).toHaveCount(0);
    });

    await qaseStep(page, 3, 'Ledger and Chat Inspector cards are listed', async () => {
      await expect(page.getByRole('link', { name: 'Ledger Inspector', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Practice activation', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Chat Inspector', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Evals', exact: true })).toBeVisible();
      // Practice is not a template reseller, so the Internal Tooling card must be absent.
      await expect(page.getByRole('link', { name: 'Internal Tooling', exact: true })).toHaveCount(0);
    });

    await qaseStep(page, 4, 'Open each card and sub-link under /internal', async () => {
      const links: Array<[string, RegExp]> = [
        ['Ledger Inspector', /\/internal\/ledger-inspector$/],
        ['Practice activation', /\/internal\/ledger-inspector\/practice-activation$/],
        ['Chat Inspector', /\/internal\/chat-inspector$/],
        ['Evals', /\/internal\/chat-inspector\/evals$/],
      ];
      for (const [name, url] of links) {
        await openPage(page, '/internal');
        await page.getByRole('link', { name, exact: true }).click();
        await expect(page).toHaveURL(url);
        await expect(page.getByText('Access denied')).toHaveCount(0);
        await expect(page.getByText('403')).toHaveCount(0);
      }
    });

    await qaseStep(page, 5, 'Old inspector URLs redirect to /internal/...', async () => {
      const redirects = [
        '/ledger-inspector',
        '/ledger-inspector/practice-activation',
        '/chat-inspector',
        '/chat-inspector/evals',
      ];
      for (const old of redirects) {
        await openPage(page, old);
        await expect(page).toHaveURL(new RegExp(`/internal${old}$`));
        await expect(page.getByText('Access denied')).toHaveCount(0);
      }
    });

    await qaseStep(page, 6, 'Old /internal-tooling redirects; non-reseller lands on /internal', async () => {
      await openPage(page, '/internal-tooling');
      // Practice is not a template reseller: expect the denial notification and a landing on /internal.
      await expect(denied.first()).toBeVisible();
      await expect(page).toHaveURL(/\/internal$/);
      await expect(heading).toBeVisible();
    });
  },
);
