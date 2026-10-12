import { expect, test, type Locator } from '@playwright/test';
import { cleanup, openPage, qaseStep } from '../../qase-step';

const NOTE_PREVIEW = 'apple banana cherry one two three';

const listShape = async (editor: Locator) =>
  editor.evaluate((el) => ({
    children: [...el.children].map((child) => child.tagName),
    lists: [...el.querySelectorAll('ul, ol')].map((list) => ({
      tag: list.tagName,
      className: list.className,
      items: [...list.querySelectorAll('li')].map((li) => (li as HTMLElement).innerText.trim()),
    })),
    emptyParagraphs: [...el.querySelectorAll('p')].filter((p) => !(p as HTMLElement).innerText.trim()).length,
  }));

test('DEMO-6004: Single-line list items round-trip unchanged after save and reopen — client note', { annotation: { type: 'qase', description: 'DEMO-6004' } }, async ({ page }) => {
  const runId = `e2e-agent-${Date.now()}`;
  test.info().annotations.push({ type: 'run-id', description: runId });
  const editor = page.locator('[contenteditable=true]');
  const noteRow = page.locator('.ant-modal tbody tr', { hasText: NOTE_PREVIEW });
  let before: Awaited<ReturnType<typeof listShape>> | undefined;
  let created = false;

  try {
    await qaseStep(page, 1, 'Open Client Info > Notes and open a note editor', async () => {
      await openPage(page, '/clients/5670');
      await page.getByTestId('c-client-info-button').click();
      await expect(page).toHaveURL(/\/clients\/5670\/info/);
      await page.getByRole('button', { name: 'Add Digital Note Button' }).click();
      created = true;
      await expect(editor).toBeVisible();
    });

    await qaseStep(page, 2, 'Create bulleted and numbered lists of single-line items', async () => {
      await editor.click();
      await editor.pressSequentially('- apple\nbanana\ncherry\n\n1. one\ntwo\nthree');

      // inferred: the case only says "one line per item with correct markers"; checked via the editor DOM
      before = await listShape(editor);
      expect(before.lists).toHaveLength(2);
      expect(before.lists[0].tag).toBe('UL');
      expect(before.lists[0].items).toEqual(['apple', 'banana', 'cherry']);
      expect(before.lists[0].className).toContain('list-disc');
      expect(before.lists[1].tag).toBe('OL');
      expect(before.lists[1].items).toEqual(['one', 'two', 'three']);
      expect(before.lists[1].className).toContain('list-decimal');
      expect(before.emptyParagraphs).toBe(0);
    });

    await qaseStep(page, 3, 'Wait for auto-save, close and reopen: lists unchanged', async () => {
      // Let the editor's auto-save debounce elapse before closing.
      await page.waitForTimeout(6000);
      await page.getByRole('button', { name: 'Digital Note Close Button' }).click();
      await expect(editor).toBeHidden();

      await openPage(page, '/clients/5670/info/notes');
      await expect(noteRow).toHaveCount(1);
      await noteRow.getByText(NOTE_PREVIEW).click();
      await expect(editor).toBeVisible();
      await expect(editor.locator('li')).toHaveCount(6);

      // inferred: "exactly as before" is checked by comparing the editor structure with step 2
      const after = await listShape(editor);
      expect(after).toEqual(before);
      expect(after.emptyParagraphs).toBe(0);
    });
  } finally {
    await cleanup(page, `delete note created by ${runId}`, async () => {
      if (!created) return;
      if (!(await noteRow.count())) {
        if (await editor.count()) await page.getByRole('button', { name: 'Digital Note Close Button' }).click();
        await openPage(page, '/clients/5670/info/notes');
      }
      if (await editor.count()) await page.getByRole('button', { name: 'Digital Note Close Button' }).click();
      await expect(noteRow).toHaveCount(1);
      await noteRow.getByTestId('digital-note-actions-menu').click();
      await page.getByRole('menuitem', { name: /Delete/ }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(noteRow).toHaveCount(0);
    });
  }
});
