import { expect, test } from '@playwright/test';
import { openPage } from '../qase-step';

// Deletes leftover client notes created by agents or generated specs (title prefix "e2e-agent-") on the sweep clients.
// Only touches rows whose title carries the prefix, so it can never delete data a human created.

const CLIENTS = (process.env.E2E_SWEEP_CLIENTS ?? '5670').split(',');
const PREFIX = 'e2e-agent-';

for (const clientId of CLIENTS) {
  test(`sweep notes on client ${clientId}`, async ({ page }) => {
    await openPage(page, `/clients/${clientId}/info/notes`);
    const rows = page.getByRole('row').filter({ hasText: PREFIX });
    await page.getByRole('row').nth(1).waitFor({ timeout: 20_000 }).catch(() => {});
    let deleted = 0;
    for (let i = 0; i < 50 && (await rows.count()) > 0; i++) {
      const row = rows.first();
      const title = (await row.getByText(PREFIX).first().textContent())?.trim();
      await row.getByTestId('digital-note-actions-menu').click();
      await page.getByRole('menuitem', { name: /delete/i }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByRole('row').filter({ hasText: title ?? PREFIX })).toHaveCount(0);
      deleted++;
    }
    test.info().annotations.push({ type: 'swept', description: `client ${clientId}: deleted ${deleted} note(s)` });
    console.log(`client ${clientId}: deleted ${deleted} leftover note(s)`);
  });
}
