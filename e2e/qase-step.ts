import { test, type Page } from '@playwright/test';

// Wraps one Qase step: shows a caption in the page (so the replay video explains itself) and groups the report.

const showCaption = (page: Page, text: string) =>
  process.env.E2E_CAPTIONS === '0' ? Promise.resolve() :
  page
    .evaluate((caption) => {
      const id = 'e2e-agent-caption';
      document.getElementById(id)?.remove();
      const el = document.createElement('div');
      el.id = id;
      el.textContent = caption;
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '16px', transform: 'translateX(-50%)', zIndex: '2147483647',
        maxWidth: '80%', padding: '8px 14px', borderRadius: '8px', pointerEvents: 'none',
        background: 'rgba(17, 24, 39, 0.88)', color: '#fff', font: '600 14px/1.4 system-ui, sans-serif',
      });
      document.body.appendChild(el);
    }, text)
    .catch(() => {});

export const qaseStep = async <T>(page: Page, position: number, title: string, body: () => Promise<T>): Promise<T> =>
  test.step(`Step ${position}: ${title}`, async () => {
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

// Navigates and waits for the app shell to finish loading. A cold deep link can stall on the global spinner (seen on
// older builds against today's dev API), so the first navigation of each test warms the app from its home route.
// Any further recovery is recorded as an annotation, so environment drift shows up in the report instead of being hidden.
const warmed = new WeakSet<Page>();

export const openPage = async (page: Page, url: string, home = '/client-list') => {
  const spinner = page.getByRole('img', { name: 'loading' }).first();
  // The spinner may not have mounted yet right after navigation, so wait for the network to go quiet first.
  const settled = async () => {
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    return spinner.waitFor({ state: 'hidden', timeout: 25_000 }).then(() => true, () => false);
  };
  if (!warmed.has(page)) {
    await page.goto(home);
    await settled();
    warmed.add(page);
  }
  await page.goto(url);
  if (await settled()) return;
  test.info().annotations.push({ type: 'app-recovery', description: `${url} stalled on the loading spinner; reloading` });
  await page.reload();
  if (await settled()) return;
  throw new Error(`${url} never finished loading (spinner still visible after a warm start and a reload)`);
};
