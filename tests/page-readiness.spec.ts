import { expect, test, type Page } from '@playwright/test';
import { openPage, type OpenPageOptions } from '../e2e/qase-step.ts';
import { legacyOpenPage } from './fixtures/legacy-open-page.ts';
import { readinessServer } from './fixtures/readiness-server.ts';

let fixture: Awaited<ReturnType<typeof readinessServer>>;
test.beforeAll(async () => {
  fixture = await readinessServer();
});
test.afterAll(async () => {
  await fixture.close();
});

const options = (page: Page): OpenPageOptions => ({
  ready: [page.locator('main[data-state="ready"]'), page.getByRole('button', { name: 'Continue' })],
  loading: page.getByRole('img', { name: 'loading', exact: true }),
  recovery: { url: `${fixture.baseURL}/home`, ready: page.getByRole('heading', { name: 'Home', exact: true }) },
  timeout: 2500,
});
const recoveries = () => test.info().annotations.filter((item) => item.type === 'app-recovery');

test('ready with continuous background requests; no warm-up or recovery', async ({ page }) => {
  const start = performance.now();
  const offset = fixture.requests.length;
  await openPage(page, `${fixture.baseURL}/destination?scenario=background`, options(page));
  expect(performance.now() - start).toBeLessThan(2000);
  expect(fixture.requests.slice(offset)).toContain('/background');
  expect(fixture.requests.slice(offset)).not.toContain('/home');
  expect(recoveries()).toEqual([]);
});

test('waits for late UI state AND a loading indicator mounted after navigation', async ({ page }) => {
  const start = performance.now();
  await openPage(page, `${fixture.baseURL}/destination?scenario=delayed`, options(page));
  expect(performance.now() - start).toBeGreaterThanOrEqual(1800);
  await expect(page.locator('main')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('img', { name: 'loading' })).toHaveCount(0);
  expect(recoveries()).toEqual([]);
});

test('checks every visible loading indicator, even with a hidden first match', async ({ page }) => {
  const start = performance.now();
  await openPage(page, `${fixture.baseURL}/destination?scenario=multiple`, options(page));
  expect(performance.now() - start).toBeGreaterThanOrEqual(450);
});

test('an absent spinner cannot make an unready page pass or trigger recovery', async ({ page }) => {
  const start = performance.now();
  const offset = fixture.requests.length;
  await expect(openPage(page, `${fixture.baseURL}/destination?scenario=never`, { ...options(page), timeout: 350 })).rejects.toThrow(
    /was not ready within 350ms.*missing:.*data-state.*loading: none/,
  );
  expect(performance.now() - start).toBeLessThan(1500);
  expect(fixture.requests.slice(offset)).not.toContain('/home');
  expect(recoveries()).toEqual([]);
});

for (const scenario of ['spinner', 'redirect']) {
  test(`recovers a demonstrated cold ${scenario} failure once and records it`, async ({ page }) => {
    const offset = fixture.requests.length;
    await openPage(page, `${fixture.baseURL}/cold?scenario=${scenario}`, { ...options(page), timeout: 350 });
    expect(fixture.requests.slice(offset).filter((path) => ['/cold', '/home'].includes(path))).toEqual(
      scenario === 'redirect' ? ['/cold', '/home', '/home', '/cold'] : ['/cold', '/home', '/cold'],
    );
    expect(recoveries()).toHaveLength(1);
    expect(recoveries()[0].description).toMatch(/not ready.*warming.*recovery succeeded/);
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  });
}

test('failed recovery retains both failures, and repeated calls cannot recover again', async ({ page }) => {
  const url = `${fixture.baseURL}/broken-cold`;
  const settings = { ...options(page), timeout: 200 };
  const failure = await openPage(page, url, settings).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(2);
  expect(String((failure as AggregateError).cause)).toContain('was not ready');
  expect(recoveries()).toHaveLength(1);
  expect(recoveries()[0].description).toContain('recovery failed');
  await expect(openPage(page, url, settings)).rejects.toThrow(/was not ready/);
  expect(recoveries()).toHaveLength(1);
});

test('failed warm-up is not ignored', async ({ page }) => {
  const failure = await openPage(page, `${fixture.baseURL}/cold`, {
    ...options(page),
    timeout: 200,
    recovery: { url: `${fixture.baseURL}/destination?scenario=never`, ready: page.locator('main[data-state="ready"]') },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map(String).join('\n')).toContain('scenario=never');
});

test('a later warm-page failure does not navigate away to recover', async ({ page }) => {
  await openPage(page, `${fixture.baseURL}/destination`, options(page));
  await expect(openPage(page, `${fixture.baseURL}/broken-cold`, { ...options(page), timeout: 200 })).rejects.toThrow(/was not ready/);
  expect(recoveries()).toEqual([]);
});

test('recovery can be disabled', async ({ page }) => {
  await expect(openPage(page, `${fixture.baseURL}/cold`, { ...options(page), timeout: 200, recovery: false })).rejects.toThrow(
    /was not ready/,
  );
  expect(recoveries()).toEqual([]);
});

for (const [path, error] of [
  ['http-error', /HTTP 503/],
  ['transport-error', /net::/],
  ['login', /was not ready/],
] as const) {
  test(`${path} failure is preserved without recovery`, async ({ page }) => {
    await expect(openPage(page, `${fixture.baseURL}/${path}`, { ...options(page), timeout: 250 })).rejects.toThrow(error);
    expect(recoveries()).toEqual([]);
  });
}

test('selector failure is preserved without recovery', async ({ page }) => {
  await expect(openPage(page, `${fixture.baseURL}/destination`, { ...options(page), ready: page.locator('[') })).rejects.toThrow(
    /selector/i,
  );
  expect(recoveries()).toEqual([]);
});

test('ready content at the wrong URL cannot pass', async ({ page }) => {
  const target = `${fixture.baseURL}/destination`;
  await expect(
    openPage(page, `${fixture.baseURL}/wrong?redirectTo=${encodeURIComponent(target)}`, { ...options(page), timeout: 250 }),
  ).rejects.toThrow(/URL matched: false; missing: none; loading: none/);
  expect(recoveries()).toEqual([]);
});

test('an intentional same-origin redirect can supply a URL predicate', async ({ page }) => {
  const target = `${fixture.baseURL}/destination`;
  await openPage(page, `${fixture.baseURL}/alias?redirectTo=${encodeURIComponent(target)}`, {
    ...options(page),
    matchesURL: (url) => url.pathname === '/destination',
  });
  expect(page.url()).toBe(target);
  expect(recoveries()).toEqual([]);
});

test('HTTP redirects preserve the requested origin even for relative URLs', async ({ browser }) => {
  const other = await readinessServer();
  const context = await browser.newContext({ baseURL: fixture.baseURL });
  const page = await context.newPage();
  try {
    await expect(
      openPage(page, `/destination?redirectTo=${encodeURIComponent(`${other.baseURL}/destination`)}`, {
        ...options(page),
        timeout: 250,
        matchesURL: () => true,
      }),
    ).rejects.toThrow(/URL matched: false/);
    expect(recoveries()).toEqual([]);
  } finally {
    await context.close();
    await other.close();
  }
});

test('a closed page does not become a recoverable readiness timeout', async ({ page }) => {
  await page.close();
  await expect(openPage(page, `${fixture.baseURL}/cold`, options(page))).rejects.toThrow(/closed/);
  expect(recoveries()).toEqual([]);
});

test('requires positive readiness for unknown destinations and rejects empty conditions', async ({ page }) => {
  await expect(openPage(page, `${fixture.baseURL}/unknown`)).rejects.toThrow(/No readiness profile/);
  await expect(openPage(page, `${fixture.baseURL}/destination`, { ready: [] })).rejects.toThrow(/positive ready locator/);
  await expect(openPage(page, `${fixture.baseURL}/destination`, { ...options(page), timeout: 0 })).rejects.toThrow(/positive, finite/);
  expect(page.url()).toBe('about:blank');
});

test('known client-list profile and legacy home argument still require loaded state', async ({ page }) => {
  await openPage(page, `${fixture.baseURL}/client-list`, `${fixture.baseURL}/client-list`);
  await expect(page.getByTestId('client-list-loaded')).toBeVisible();
  expect(recoveries()).toEqual([]);
});

test('before/after timings on identical disposable fixtures', async ({ browser }) => {
  test.skip(process.env.READINESS_BENCHMARK !== '1', 'Opt in to the original 30-second networkidle waits');
  test.setTimeout(180_000);
  const measurements = [];
  for (const scenario of ['background', 'delayed', 'never', 'cold']) {
    for (const implementation of ['before', 'after']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = `${fixture.baseURL}/${scenario === 'cold' ? 'cold' : 'destination'}?scenario=${scenario}`;
      const home = `${fixture.baseURL}/home?scenario=${scenario}`;
      const start = performance.now();
      const offset = fixture.requests.length;
      const annotationCount = recoveries().length;
      let error: string | undefined;
      try {
        if (implementation === 'before') await legacyOpenPage(page, url, home);
        else {
          const { timeout: _, ...settings } = options(page); // Measure the production 15-second default, not shortened test budgets.
          await openPage(page, url, {
            ...settings,
            recovery: { url: home, ready: page.getByRole('heading', { name: 'Home', exact: true }) },
          });
        }
      } catch (failure) {
        error = String(failure);
      }
      const elapsedMs = Math.round(performance.now() - start);
      const ready = await page.locator('main[data-state="ready"]').isVisible();
      const loading = await page.getByRole('img', { name: 'loading' }).filter({ visible: true }).count();
      const outcome = error ? 'failed' : ready && !loading ? 'ready' : 'returned before ready';
      measurements.push({
        scenario,
        implementation,
        elapsedMs,
        outcome,
        recoveries: recoveries().length - annotationCount,
        documentRequests: fixture.requests.slice(offset).filter((path) => path !== '/background' && path !== '/favicon.ico'),
        error,
      });
      console.log(JSON.stringify(measurements.at(-1)));
      await context.close();
      expect(outcome).toBe(
        implementation === 'before' && ['never', 'delayed'].includes(scenario)
          ? 'returned before ready'
          : scenario === 'never'
            ? 'failed'
            : 'ready',
      );
    }
  }
  await test.info().attach('readiness-timings.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});
