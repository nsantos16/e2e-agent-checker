import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { atomicJson, collectNetwork, safeUrl } from './network.ts';

export type BrowserObservation = { stage: string; status: 'active' | 'closed'; updatedAt: string; frameAt?: string; pageUrl?: string };
export type ObserverOptions = { runDir: string; artifactDir: string; stage: string };
const observers = new WeakMap<BrowserContext, ReturnType<typeof createObserver>>();
function createObserver(context: BrowserContext, options: ObserverOptions) {
  const liveDir = join(options.runDir, 'live');
  mkdirSync(liveDir, { recursive: true });
  const network = collectNetwork(context, {
    path: join(options.artifactDir, 'network.json'),
    stage: options.stage,
    actionPath: join(liveDir, 'action.json'),
  });
  let page: Page | undefined,
    stopped = false,
    capturing: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  const state: BrowserObservation = { stage: options.stage, status: 'active', updatedAt: new Date().toISOString() };
  const publish = () => {
    state.updatedAt = new Date().toISOString();
    atomicJson(join(liveDir, 'browser.json'), state);
  };
  const capture = () => {
    if (stopped || capturing || !page || page.isClosed()) return;
    const target = page;
    capturing = (async () => {
      try {
        const frame = await target.screenshot({ type: 'jpeg', quality: 55, scale: 'css', timeout: 1500 });
        if (stopped || target !== page) return;
        const path = join(liveDir, 'frame.jpg');
        writeFileSync(path + '.tmp', frame, { mode: 0o600 });
        renameSync(path + '.tmp', path);
        state.frameAt = new Date().toISOString();
        state.pageUrl = safeUrl(target.url());
        publish();
      } catch {
        /* Navigation/closure can interrupt a frame; retain the previous image. */
      }
    })().finally(() => {
      capturing = undefined;
    });
  };
  const attach = (next: Page) => {
    page = next;
    next.on('framenavigated', (frame) => {
      if (frame === next.mainFrame()) page = next;
    });
    next.once('close', () => {
      if (page === next)
        page = context
          .pages()
          .filter((p) => !p.isClosed())
          .at(-1);
    });
    capture();
  };
  context.on('page', attach);
  context.pages().forEach(attach);
  const timer = setInterval(capture, 1000);
  timer.unref();
  publish();
  const close = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      context.off('page', attach);
      await capturing;
      capture();
      await capturing;
      stopped = true;
      await network.close();
      state.status = 'closed';
      publish();
    })());
  context.once('close', () => {
    void close();
  });
  return { close };
}
export function observeBrowser(page: Page, options: ObserverOptions) {
  let observer = observers.get(page.context());
  if (!observer) {
    observer = createObserver(page.context(), options);
    observers.set(page.context(), observer);
  }
  return observer;
}
