import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Settings, composer, real API and MCP retain the selected native account', { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-provider-api-'));
  const binary = join(dir, 'native');
  copyFileSync(resolve('tests/fixtures/native-provider.mjs'), binary);
  chmodSync(binary, 0o755);
  for (const name of ['work', 'personal', 'additional']) {
    mkdirSync(join(dir, name));
    writeFileSync(
      join(dir, name, 'profile.json'),
      JSON.stringify({
        email: `${name}@fixture.test`,
        models: [
          'sonnet',
          'a-model-with-a-long-unbroken-name-to-check-wrapping',
          ...Array.from({ length: 18 }, (_, i) => `fixture-${i + 1}`),
        ],
      }),
    );
  }
  const statePath = join(dir, 'providers.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      instances: [
        {
          id: 'claude-code-default',
          provider: 'claude-code',
          name: 'Work Claude',
          enabled: true,
          binaryPath: binary,
          configDir: join(dir, 'work'),
          options: {},
          revision: 'initial',
        },
        {
          id: 'codex-default',
          provider: 'codex',
          name: 'Codex',
          enabled: false,
          binaryPath: 'not-installed',
          options: {},
          revision: 'initial',
        },
        {
          id: 'cursor-default',
          provider: 'cursor',
          name: 'Cursor',
          enabled: false,
          binaryPath: 'not-installed',
          options: {},
          revision: 'initial',
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'environments.json'),
    JSON.stringify([
      {
        id: 'local',
        name: 'Fixture',
        kind: 'hosted',
        baseUrl: 'http://127.0.0.1:1',
        revision: 'fixture',
        users: [
          { id: 'qa', name: 'QA', usernameRef: 'env://CHECKER_TEST_MISSING_USER', passwordRef: 'env://CHECKER_TEST_MISSING_PASSWORD' },
        ],
      },
    ]),
  );
  const portProbe = createServer();
  await new Promise<void>((r) => portProbe.listen(0, '127.0.0.1', r));
  const port = (portProbe.address() as any).port;
  await new Promise<void>((r) => portProbe.close(() => r()));
  const env = {
    ...process.env,
    E2E_APP_PORT: String(port),
    E2E_APP_OPEN: '0',
    E2E_PROVIDERS_PATH: statePath,
    E2E_JOBS_PATH: join(dir, 'jobs.json'),
    E2E_CASES_PATH: join(dir, 'cases.json'),
    E2E_ENVIRONMENTS_PATH: join(dir, 'environments.json'),
    E2E_FAKE_KIND: 'claude-code',
    ANTHROPIC_API_KEY: 'secret-ui-test-must-not-appear',
  } as Record<string, string>;
  const app = spawn(process.execPath, ['src/app/server.ts'], { env, stdio: 'ignore' });
  const closed = new Promise<void>((r) => app.once('exit', () => r()));
  const client = new Client({ name: 'providers-test', version: '1' });
  const browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, body?: any) => {
    const r = await fetch(
      base + path,
      body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    return { status: r.status, data: await r.json() };
  };
  const call = async (name: string, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return (r.structuredContent as any).data;
  };
  const screenshots = process.env.E2E_SETTINGS_SCREENSHOTS;
  if (screenshots) mkdirSync(screenshots, { recursive: true });
  try {
    for (let n = 0; n < 100; n++) {
      if (
        await fetch(base + '/api/config').then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp-server.ts'], env, stderr: 'ignore' }));
    const saved = await call('save_provider_instance', {
      instance: { id: 'personal', provider: 'claude-code', name: 'Personal Claude', binaryPath: binary, configDir: join(dir, 'personal') },
    });
    await call('select_provider_instance', { instanceId: 'personal', expectedRevision: saved.revision });
    const models = await call('list_models', { provider: 'claude-code', instanceId: 'personal', fresh: true });
    assert.equal(models.account.email, 'personal@fixture.test');
    const legacy = await call('list_models', { provider: 'claude-code' });
    assert.equal(legacy.instanceId, 'claude-code-default');
    const login = await call('provider_login', { instanceId: 'personal', expectedRevision: saved.revision });
    assert.match(login.loginCommand, /CLAUDE_CONFIG_DIR=/);
    assert.match(login.loginCommand, /personal/);
    const invalid = await api('/api/provider-instances', {
      instance: { ...saved, revision: undefined, enabled: false },
      expectedRevision: 'stale',
    });
    assert.equal(invalid.data.code, 'REVISION_CONFLICT');
    const testCase = await call('create_case', {
      title: 'Provider selection fixture',
      status: 'active',
      steps: [{ action: 'Open fixture', expected_result: 'Ready' }],
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.locator('#settings-open').click();
    await expect(page.getByRole('tab', { name: 'Providers', exact: true })).toHaveAttribute('aria-selected', 'true');
    const card = page.locator('[data-provider-instance="personal"]');
    await expect(card).toContainText('personal@fixture.test');
    await expect(card.locator('input[name="name"]')).not.toBeVisible();
    await expect(card.getByText('API overrides ignored', { exact: true })).not.toBeVisible();
    // Creating an account needs a name and separate profile; its permanent ID is generated automatically.
    await page.getByRole('button', { name: 'Add account', exact: true }).click();
    const form = page.locator('.provider-instance-form');
    await form.getByRole('button', { name: /^Provider:/ }).click();
    const providerPicker = page.getByRole('dialog', { name: 'Provider', exact: true });
    await expect(providerPicker.getByRole('option', { name: /Cursor/ })).toBeDisabled();
    if (screenshots) await page.screenshot({ path: join(screenshots, 'provider-picker.png') });
    await providerPicker.getByRole('combobox').press('ArrowDown');
    await providerPicker.getByRole('combobox').press('Enter');
    await expect(form.getByRole('button', { name: 'Provider: Codex / ChatGPT', exact: true })).toBeFocused();
    await form.getByRole('button', { name: /^Provider:/ }).click();
    await providerPicker.getByRole('combobox').press('ArrowDown');
    await providerPicker.getByRole('combobox').press('Enter');
    await expect(form.getByRole('button', { name: 'Provider: Claude Code', exact: true })).toBeFocused();
    await form.getByLabel('Account name', { exact: false }).fill('Additional Claude');
    await form.getByLabel('Profile directory', { exact: false }).fill(join(dir, 'additional'));
    await form.locator('summary', { hasText: 'Advanced settings' }).click();
    await form.getByLabel('Executable', { exact: false }).fill(binary);
    if (screenshots) await page.screenshot({ path: join(screenshots, 'settings-add-account.png') });
    await form.getByRole('button', { name: 'Add account', exact: true }).click();
    const added = page.locator('.provider-detail');
    await expect(added).toContainText('additional@fixture.test');
    const addedId = await added.getAttribute('data-provider-instance');
    assert.match(addedId!, /^claude-code-additional-claude-[a-f0-9]{8}$/);
    await added.locator('summary', { hasText: 'Configuration' }).click();
    await added.getByRole('button', { name: 'Remove account', exact: true }).click();
    await expect(page.locator(`[data-manage-provider="${addedId}"]`)).toHaveCount(0);
    assert.match(readFileSync(join(dir, 'additional', 'profile.json'), 'utf8'), /additional@fixture.test/);
    await page.locator('[data-manage-provider="personal"]').click();
    await card.locator('summary', { hasText: 'Configuration' }).click();
    await page.locator('.provider-instance-form input[name="name"]').fill('Personal updated');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(card).toContainText('Personal updated');
    await card.locator('summary', { hasText: 'Configuration' }).click();
    // Sign-in stays explicit. The long shell command is available without dominating the screen.
    await card.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(card.locator('.provider-login code')).not.toBeVisible();
    await card.locator('summary', { hasText: 'Show command' }).click();
    await expect(card.locator('.provider-login')).toContainText('CLAUDE_CONFIG_DIR=');
    await card.getByRole('button', { name: 'Check connection', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Connection refreshed' })).toBeVisible();
    // Long commands and account metadata stay inside the dialog on desktop, tablet and mobile.
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const dimensions = await page.locator('#settings-dialog').evaluate((dialog) => ({
        width: dialog.getBoundingClientRect().width,
        height: dialog.getBoundingClientRect().height,
        overflow: [...dialog.querySelectorAll('.settings-content, .provider-editor, .provider-login')].some(
          (e) => e.scrollWidth > e.clientWidth + 1,
        ),
      }));
      assert.ok(dimensions.width <= viewport.width && dimensions.height <= viewport.height);
      assert.equal(dimensions.overflow, false, `Settings must fit at ${viewport.width}px`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `settings-signin-${viewport.width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await card.getByRole('button', { name: 'Reconnect', exact: true }).click();
    if (screenshots) {
      await page.locator('.settings-content').evaluate((e) => (e.scrollTop = 0));
      await page.screenshot({ path: join(screenshots, 'settings-desktop.png') });
      await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
      await page.screenshot({ path: join(screenshots, 'settings-light.png') });
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    }
    await page.getByRole('tab', { name: 'Providers', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Environments', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#environment-form')).toBeVisible();
    if (screenshots) await page.screenshot({ path: join(screenshots, 'settings-environments.png') });
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'Providers', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-manage-provider="codex-default"]').click();
    const disabled = page.locator('[data-provider-instance="codex-default"]');
    await expect(disabled).toContainText('Disabled');
    await expect(disabled.getByRole('button', { name: 'Use account', exact: true })).toBeDisabled();
    await page.locator('[data-manage-provider="personal"]').click();
    await card.getByRole('button', { name: 'Use account', exact: true }).click();
    await expect(page.locator('#model-dialog')).toBeVisible();
    await expect(page.locator('[data-picker-instance="personal"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.model-group-label')).toContainText('Personal updated');
    const pickerColumns = await page.locator('.model-picker-body').evaluate((body) => {
      const rail = body.querySelector('.provider-rail')!.getBoundingClientRect();
      const models = body.querySelector('.model-list')!.getBoundingClientRect();
      return { railRight: rail.right, modelsLeft: models.left };
    });
    assert.ok(pickerColumns.railRight <= pickerColumns.modelsLeft, 'Account names must not overlap the model list');
    // A full native catalog must scroll inside the picker, never under Done or over the composer.
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 900, height: 700 },
      { width: 539, height: 1348 },
      { width: 390, height: 844 },
      { width: 360, height: 600 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      const measure = () =>
        page.locator('#model-dialog').evaluate((dialog) => {
          const box = dialog.getBoundingClientRect();
          const list = dialog.querySelector('.model-list')!;
          const footer = dialog.querySelector('.picker-footer')!.getBoundingClientRect();
          const composer = document.querySelector('.composer')!.getBoundingClientRect();
          return {
            fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
            aboveComposer: box.bottom <= composer.top - 7,
            aboveFooter: list.getBoundingClientRect().bottom <= footer.top + 1,
            scrolls: list.scrollHeight > list.clientHeight,
            horizontalOverflow: [...dialog.querySelectorAll('.model-picker-body, .model-list, .model-effort')].some(
              (e) => e.scrollWidth > e.clientWidth + 1,
            ),
          };
        });
      await expect.poll(measure, { message: `Picker layout at ${viewport.width}×${viewport.height}` }).toEqual({
        fits: true,
        aboveComposer: true,
        aboveFooter: true,
        scrolls: true,
        horizontalOverflow: false,
      });
      const lastModel = page.locator('[data-model="fixture-18"]');
      await lastModel.scrollIntoViewIfNeeded();
      assert.equal(
        await lastModel.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el;
        }),
        true,
        'The last model remains reachable above the footer',
      );
      if (screenshots) await page.screenshot({ path: join(screenshots, `model-picker-${viewport.width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (screenshots) await page.screenshot({ path: join(screenshots, 'settings-model-picker.png') });
    const effort = page.getByRole('button', { name: /^sonnet effort:/ });
    await effort.click();
    const effortMenu = page.getByRole('dialog', { name: 'sonnet effort', exact: true });
    if (screenshots) await page.screenshot({ path: join(screenshots, 'effort-picker.png') });
    await effortMenu.getByRole('combobox').fill('low');
    await effortMenu.getByRole('combobox').press('Enter');
    await expect(effort).toBeFocused();
    await expect(effort).toHaveText('low');
    await expect(page.locator('#model-dialog')).toBeVisible();
    await effort.click();
    await effortMenu.getByRole('combobox').press('ArrowDown');
    await effortMenu.getByRole('combobox').press('Escape');
    await expect(effortMenu).toHaveCount(0);
    await expect(effort).toBeFocused();
    await expect(effort).toHaveText('low');
    await effort.click();
    await page.mouse.click(5, 5);
    await expect(effortMenu).toHaveCount(0);
    await expect(page.locator('#model-dialog')).toBeVisible();
    await page.locator('#model-dialog').getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('#model-button')).toHaveAttribute('title', /Personal updated/);
    await page.locator(`input[type="checkbox"][data-select="${testCase.project}-${testCase.id}"]`).check();
    const submitted = page.waitForResponse((r) => r.url() === base + '/api/jobs' && r.request().method() === 'POST');
    await page.locator('#run-selected').click();
    const response = await submitted;
    assert.equal(response.status(), 200);
    const ids = await response.json();
    const job = (await api('/api/jobs/' + ids[0])).data;
    assert.equal(job.target.instanceId, 'personal');
    assert.equal(job.target.options.effort, 'low');
    assert.equal(job.providerSnapshot.name, 'Personal updated');
    assert.equal(job.providerSnapshot.account.email, 'personal@fixture.test');
    assert.equal(job.target.instanceRevision, job.providerSnapshot.revision);
    const compact = await call('get_job', { jobId: ids[0] });
    assert.equal(compact.target.instanceId, 'personal');
    const legacyRun = await call('verify_case', {
      project: testCase.project,
      caseId: testCase.id,
      target: { provider: 'claude-code', model: 'sonnet' },
      idempotencyKey: 'legacy',
    });
    const legacyJob = (await api('/api/jobs/' + legacyRun.jobId)).data;
    assert.equal(legacyJob.target.instanceId, 'claude-code-default');
    assert.notEqual(legacyJob.target.accountFingerprint, job.target.accountFingerprint);
    assert.doesNotMatch(await page.locator('body').innerText(), /secret-ui-test-must-not-appear|must-not-escape/);
    assert.deepEqual(errors, []);
    const persisted = JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8'));
    assert.equal(persisted.find((j: any) => j.id === ids[0]).target.instanceId, 'personal');
  } finally {
    await browser.close();
    await client.close();
    app.kill('SIGTERM');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
