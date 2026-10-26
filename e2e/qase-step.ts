import { test, type Locator, type Page } from '@playwright/test';
import { join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observeBrowser } from '../src/browser-observer.ts';
import { atomicJson } from '../src/network.ts';

// The shared helper is imported by generated specs, including previously saved replays.
const observers = new WeakMap<Page, ReturnType<typeof observeBrowser>>();
if (process.env.E2E_OBSERVATION_RUN_DIR) {
  test.beforeEach(async ({ page }) => {
    const artifactDir = process.env.E2E_OUTPUT_DIR!;
    observers.set(
      page,
      observeBrowser(page, {
        runDir: process.env.E2E_OBSERVATION_RUN_DIR!,
        artifactDir,
        stage: artifactDir.includes('/codify/attempts/') ? `codify/${basename(artifactDir)}` : basename(artifactDir),
      }),
    );
  });
  test.afterEach(async ({ page }) => {
    await observers.get(page)?.close();
  });
}

// Wraps one Qase step: shows a caption in the page (so the replay video explains itself) and groups the report.

const showCaption = (page: Page, text: string) =>
  process.env.E2E_CAPTIONS === '0'
    ? Promise.resolve()
    : page
        .evaluate((caption) => {
          const id = 'e2e-agent-caption';
          document.getElementById(id)?.remove();
          const el = document.createElement('div');
          el.id = id;
          el.textContent = caption;
          el.setAttribute('aria-hidden', 'true');
          Object.assign(el.style, {
            position: 'fixed',
            left: '50%',
            bottom: '16px',
            transform: 'translateX(-50%)',
            zIndex: '2147483647',
            maxWidth: '80%',
            padding: '8px 14px',
            borderRadius: '8px',
            pointerEvents: 'none',
            background: 'rgba(17, 24, 39, 0.88)',
            color: '#fff',
            font: '600 14px/1.4 system-ui, sans-serif',
          });
          document.body.appendChild(el);
        }, text)
        .catch(() => {});

export const qaseStep = async <T>(page: Page, position: number, title: string, body: () => Promise<T>): Promise<T> =>
  test.step(`Step ${position}: ${title}`, async () => {
    if (process.env.E2E_OBSERVATION_RUN_DIR)
      atomicJson(join(process.env.E2E_OBSERVATION_RUN_DIR, 'live/action.json'), {
        name: `Step ${position}: ${title}`,
        at: new Date().toISOString(),
      });
    await showCaption(page, `Step ${position}: ${title}`);
    // Re-show after navigations so the caption survives page loads during the step.
    const reshow = () => void showCaption(page, `Step ${position}: ${title}`);
    page.on('load', reshow);
    try {
      return await body();
    } finally {
      page.off('load', reshow);
    }
  });

// Best-effort cleanup of data the test created: failures are recorded, never thrown, so they can't mask the verdict.
export const cleanup = async (page: Page, what: string, body: () => Promise<void>) => {
  await test.step(`Cleanup: ${what}`, async () => {
    await showCaption(page, `Cleanup: ${what}`);
    try {
      await body();
    } catch (error) {
      test.info().annotations.push({ type: 'cleanup-failed', description: `${what}: ${String(error).split('\n')[0]}` });
      console.warn(`cleanup failed (${what}) on ${page.url()}: ${String(error).split('\n')[0]}`);
    }
  });
};

type Locators = Locator | readonly Locator[];
export type PageReadiness = {
  // Positive evidence that the destination has initialized (loaded data/empty state, usable controls, etc.).
  // A shell, heading, or absent spinner alone is insufficient. Encode application state in the locator where possible.
  ready: Locators;
  // Only indicators that block this destination. Every visible match is checked, including late mounts.
  loading?: Locators;
  // Defaults check the pathname, allowing search-param normalization. Override for intentional redirects.
  matchesURL?: (url: URL) => boolean;
};
export type OpenPageOptions = Partial<PageReadiness> & {
  // One budget for navigation + readiness, per attempt (including each recovery leg).
  timeout?: number;
  // A cold failure may warm this destination once, then retry the original URL. No unconditional warm-up.
  recovery?: false | (Partial<PageReadiness> & { url: string });
};

const readyPages = new WeakSet<Page>();
const recoveredPages = new WeakSet<Page>();
const asLocators = (value: Locators | undefined): readonly Locator[] => (value ? (Array.isArray(value) ? value : [value as Locator]) : []);
const pathname = (url: string) => new URL(url, 'http://relative.invalid').pathname.replace(/\/$/, '') || '/';

// Compatibility profiles for saved Sample replays. New destinations must supply their own positive readiness evidence.
// These selectors reflect data-loading state, not the presence of the shared navigation shell.
function destinationReadiness(page: Page, url: string): PageReadiness {
  const path = pathname(url);
  const loadingWithin = (region: Locator) => [
    region.locator('.ant-spin-nested-loading > div > .ant-spin-spinning, [aria-busy="true"], .ant-skeleton-active'),
    region.getByText('Loading...', { exact: true }),
  ];
  if (path === '/client-list')
    return {
      ready: page
        .getByTestId('client-list-loaded')
        .or(page.getByTestId('clientListTable').getByRole('table'))
        .filter({ visible: true })
        .first(),
      loading: loadingWithin(page.locator('#client-list')),
    };
  if (/^\/clients\/\d+\/info\/notes$/.test(path)) {
    const addNote = page.getByRole('button', { name: 'Add Digital Note Button', exact: true });
    const notes = page.locator('.ant-table-wrapper').filter({ has: addNote });
    return { ready: [addNote, notes.getByRole('table')], loading: loadingWithin(notes) };
  }
  if (/^\/clients\/\d+$/.test(path)) {
    const clientId = path.split('/')[2];
    return {
      ready: page.getByTestId('c-client-info-button'),
      loading: loadingWithin(page.locator('#close, #close-next, #tax-return')),
      matchesURL: (current) =>
        current.pathname.startsWith(`${path}/`) ||
        (['/close', '/tax-return'].includes(current.pathname) && current.searchParams.get('cid') === clientId),
    };
  }
  if (/\/bank-feeds(?:-next)?$/.test(path)) {
    const next = path.endsWith('-next');
    const region = page.locator(next ? '#bank-feeds-next' : '#bank-feeds');
    return {
      ready: next
        ? [
            page.getByTestId('bank-feeds-next-accounts-btn'),
            region
              .getByRole('navigation', { name: 'Bank feed accounts' })
              .or(region.getByTestId('bf-add-account-btn'))
              .or(region.getByTestId('bf-map-accounts-empty-state'))
              .filter({ visible: true })
              .first(),
          ]
        : [page.getByTestId('bf-accounts-btn'), page.getByTestId('bf-map-accounts-badge')],
      loading: loadingWithin(region),
    };
  }
  if (path === '/firm-tasks')
    return { ready: page.getByTestId('firm-task-area'), loading: loadingWithin(page.getByTestId('firm-task-page')) };
  if (path === '/internal/ledger-inspector' || path === '/ledger-inspector')
    return {
      ready: [
        page.getByRole('combobox', { name: /Provider/ }),
        page
          .getByText(/^#\d+ ·/)
          .or(page.getByText(/^No clients (match the active filters|have ledger cache state)\.?$/))
          .filter({ visible: true })
          .first(),
      ],
      loading: loadingWithin(page.locator('aside').filter({ has: page.getByRole('combobox', { name: /Provider/ }) })),
      matchesURL: (current) => pathname(current.href) === '/internal/ledger-inspector',
    };
  throw new Error(`No readiness profile for ${url}; pass openPage(page, url, { ready, loading }) with destination-specific locators`);
}

function resolveReadiness(page: Page, url: string, options: Partial<PageReadiness>): PageReadiness {
  const profile = options.ready === undefined ? destinationReadiness(page, url) : { ready: options.ready };
  const readiness = { ...profile, ...options };
  if (asLocators(readiness.ready).length === 0) throw new Error(`Readiness for ${url} requires at least one positive ready locator`);
  return readiness;
}

class ReadinessTimeoutError extends Error {
  destination: URL;
  constructor(message: string, destination: URL) {
    super(message);
    this.name = 'ReadinessTimeoutError';
    this.destination = destination;
  }
}

async function navigateWhenReady(page: Page, url: string, readiness: PageReadiness, timeout: number) {
  const deadline = performance.now() + timeout;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  if (response && response.status() >= 400)
    throw new Error(`Navigation to ${url} failed: HTTP ${response.status()} ${response.statusText()}`);
  // Keep the requested origin even when HTTP redirects finish on another origin.
  let request = response?.request();
  while (request?.redirectedFrom()) request = request.redirectedFrom()!;
  const destination = new URL(request?.url() ?? url, page.url());
  const matchesURL = readiness.matchesURL ?? ((current: URL) => pathname(current.href) === pathname(url));
  const ready = asLocators(readiness.ready);
  const loading = asLocators(readiness.loading);
  for (;;) {
    // Resolve fresh locators on every poll: checking an absent spinner once can race application mounting.
    // Errors such as invalid selectors or a closed page are deliberately not turned into readiness timeouts.
    const missing: string[] = [];
    for (const locator of ready) if (!(await locator.isVisible())) missing.push(locator.toString());
    const visibleLoading: string[] = [];
    for (const locator of loading) if (await locator.filter({ visible: true }).count()) visibleLoading.push(locator.toString());
    const current = new URL(page.url());
    const correctURL = current.origin === destination.origin && matchesURL(current);
    if (correctURL && !missing.length && !visibleLoading.length) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new ReadinessTimeoutError(
        `${url} was not ready within ${timeout}ms; current URL: ${page.url()}; ` +
          `URL matched: ${correctURL}; missing: ${missing.join(', ') || 'none'}; loading: ${visibleLoading.join(', ') || 'none'}`,
        destination,
      );
    await delay(Math.min(100, remaining));
  }
}

// Keeps the legacy third-argument home URL for saved replays; unknown destinations need explicit readiness.
export const openPage = async (page: Page, url: string, optionsOrHome: OpenPageOptions | string = {}) => {
  const options: OpenPageOptions = typeof optionsOrHome === 'string' ? { recovery: { url: optionsOrHome } } : optionsOrHome;
  const timeout = options.timeout ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('openPage timeout must be a positive, finite number');
  const readiness = resolveReadiness(page, url, options);
  try {
    await navigateWhenReady(page, url, readiness, timeout);
    readyPages.add(page);
  } catch (failure) {
    // Only a failed cold navigation with evidence of the known spinner/home-redirect problem gets recovery.
    // Assertion failures in callers, HTTP/transport failures, login redirects, and warm-page failures propagate.
    if (!(failure instanceof ReadinessTimeoutError) || options.recovery === false || readyPages.has(page) || recoveredPages.has(page))
      throw failure;
    const home = options.recovery ?? { url: '/client-list' };
    const current = new URL(page.url());
    const homeURL = new URL(home.url, current);
    if (
      pathname(url) === pathname(home.url) ||
      current.origin !== failure.destination.origin ||
      current.origin !== homeURL.origin ||
      /\/(login|sign-in)(?:\/|$)/.test(current.pathname)
    )
      throw failure;
    const spinnerVisible = (await page.getByRole('img', { name: 'loading', exact: true }).filter({ visible: true }).count()) > 0;
    const atDestination = readiness.matchesURL?.(current) ?? pathname(current.href) === pathname(url);
    if (pathname(current.href) !== pathname(home.url) && !(atDestination && spinnerVisible)) throw failure;
    recoveredPages.add(page);
    const annotation = {
      type: 'app-recovery',
      description: `${failure.message}; warming ${home.url} and retrying ${url}`,
    };
    test.info().annotations.push(annotation);
    try {
      await navigateWhenReady(page, homeURL.href, resolveReadiness(page, homeURL.href, home), timeout);
      await navigateWhenReady(page, url, readiness, timeout);
      readyPages.add(page);
      annotation.description += '; recovery succeeded';
    } catch (recoveryFailure) {
      annotation.description += `; recovery failed: ${String(recoveryFailure)}`;
      throw new AggregateError([failure, recoveryFailure], `Cold navigation recovery failed for ${url}: ${String(recoveryFailure)}`, {
        cause: failure,
      });
    }
  }
};
