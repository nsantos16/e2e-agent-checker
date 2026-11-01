import { test, expect, type Page, type Locator } from '@playwright/test';
import { join } from 'node:path';
import { qaseStep } from './qase-step.ts';
import { mockSuiteSchema, type MockInput } from '../src/mock-contract.ts';
import { installMockNetwork } from '../src/mock-network.ts';
import { atomicJson } from '../src/network.ts';

export async function runMockScenario(page: Page, raw: unknown, scenarioId: string, allowed: MockInput['allowedLiveRequests']) {
  const suite = mockSuiteSchema.parse(raw);
  const scenario = suite.scenarios.find((s) => s.id === scenarioId)!;
  if (!scenario) throw new Error('Unknown scenario');
  const base = test.info().project.use.baseURL!;
  const out = process.env.E2E_OUTPUT_DIR!;
  const network = await installMockNetwork(page.context(), scenario, suite, allowed, base, (requests) =>
    atomicJson(join(out, 'mock-network.json'), {
      version: 1,
      scenario: scenarioId,
      requests,
    }),
  );
  const locator = (l: { kind: string; value: string; name?: string }): Locator => {
    if (l.kind === 'testId') return page.getByTestId(l.value);
    if (l.kind === 'text') return page.getByText(l.value, { exact: true });
    if (l.kind === 'label') return page.getByLabel(l.value, { exact: true });
    if (l.kind === 'role')
      return page.getByRole(l.value as Parameters<Page['getByRole']>[0], {
        name: l.name,
        exact: true,
      });
    return page.locator(l.value);
  };
  try {
    for (const step of scenario.steps)
      await qaseStep(page, step.position, `${scenario.title}: ${step.acceptance}`, async () => {
        for (const action of step.operations) {
          if (action.op === 'goto') {
            await page.goto(new URL(action.url, base).href);
            continue;
          }
          if (action.op === 'url') {
            await expect(page).toHaveURL(new URL(action.url, base).href);
            continue;
          }
          const target = locator(action.locator);
          switch (action.op) {
            case 'click':
              await target.click();
              break;
            case 'fill':
              await target.fill(action.value);
              break;
            case 'press':
              await target.press(action.key);
              break;
            case 'check':
              await target.setChecked(action.checked);
              break;
            case 'select':
              await target.selectOption(action.value);
              break;
            case 'visible':
              await expect(target).toBeVisible();
              break;
            case 'hidden':
              await expect(target).toBeHidden();
              break;
            case 'text':
              await expect(target).toHaveText(action.value);
              break;
            case 'value':
              await expect(target).toHaveValue(action.value);
              break;
            case 'count':
              await expect(target).toHaveCount(action.value);
              break;
          }
        }
      });
  } finally {
    // Capture selector/DOM evidence for repairs, without granting arbitrary browser JS.
    await page
      .locator('body')
      .ariaSnapshot()
      .then((snapshot) =>
        atomicJson(join(out, 'mock-dom.json'), {
          scenario: scenarioId,
          snapshot,
        }),
      )
      .catch(() => {});
    // Close all pages before the final check so late requests cannot escape the verdict.
    await page.context().close();
    await test.step('Mock request contract', async () => network.assertComplete());
  }
}
