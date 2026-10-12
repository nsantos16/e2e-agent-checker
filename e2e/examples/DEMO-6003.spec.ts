import { expect, test } from '@playwright/test';
import { cleanup, openPage, qaseStep } from '../qase-step';

test('DEMO-6003: Multi-line list item (Shift+Enter) persists after save and reopen', { annotation: { type: 'qase', description: 'DEMO-6003' } }, async ({ page }) => {
  const title = `e2e-agent-${Date.now()}`;
  const editor = page.locator('[contenteditable="true"]');
  const noteRow = page.getByRole('row').filter({ hasText: title });
  let created = false;

  // a direct visit to the notes URL sometimes redirects to /client-list on the first attempt, so retry until the note list shows
  const openNotesList = async (row = noteRow) => {
    await expect(async () => {
      await openPage(page, '/clients/5670/info/notes');
      await expect(row).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });
  };

  try {
    await qaseStep(page, 1, 'Open Client Info > Notes and start a new note', async () => {
      await openPage(page, '/clients/5670');
      await page.getByText('Loading...').first().waitFor({ state: 'hidden' });
      await page.getByTestId('c-client-info-button').click();
      await page.getByRole('button', { name: 'Add Digital Note Button' }).click();
      created = true;
      await expect(page.getByRole('textbox', { name: 'Digital Note Title Input' })).toBeVisible();
      await expect(editor).toBeVisible();
    });

    await qaseStep(page, 2, 'Start a bulleted list with text in the first item', async () => {
      await page.getByRole('textbox', { name: 'Digital Note Title Input' }).fill(title);
      await editor.click();
      await editor.pressSequentially('- First line');
      await expect(editor.locator('ul > li')).toHaveCount(1);
      await expect(editor.locator('ul > li')).toContainText('First line');
    });

    await qaseStep(page, 3, 'Shift+Enter in the list item and type a second line', async () => {
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('Second line');
      // soft break stays inside the same item: no second marker
      await expect(editor.locator('ul > li')).toHaveCount(1);
      await expect(editor.locator('ul > li')).toContainText('First line');
      await expect(editor.locator('ul > li')).toContainText('Second line');
    });

    await qaseStep(page, 4, 'Wait for auto-save, then close the note editor', async () => {
      await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Digital Note Close Button' }).click();
      await expect(editor).toBeHidden();
      // inferred: modal closing not verified directly; the saved note must be listed after a fresh load
      await openNotesList();
    });

    await qaseStep(page, 5, 'Reopen the note: both lines still separate in the list', async () => {
      await noteRow.getByText(title).click();
      const item = editor.locator('ul > li');
      await expect(item).toHaveCount(1);
      await expect(item.locator('div').filter({ hasText: /^First line$/ })).toHaveCount(1);
      await expect(item.locator('div').filter({ hasText: /^Second line$/ })).toHaveCount(1);
    });
  } finally {
    if (created) {
      await cleanup(page, `delete note ${title}`, async () => {
        await openNotesList();
        await noteRow.getByTestId('digital-note-actions-menu').click();
        await page.getByRole('menuitem', { name: /delete/i }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(noteRow).toBeHidden();
      });
    }
  }
});
