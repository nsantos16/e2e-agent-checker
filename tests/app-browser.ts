import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ensureFrontend, frontendAsset, frontendDirectory } from '../src/app/frontend.ts';

// Serve only the production UI and inert bootstrap APIs. Each browser suite owns
// its fixture API/state in an isolated frame; no real jobs or credentials are used.
await ensureFrontend();
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/') {
    res.setHeader('content-type', 'text/html');
    return res.end(readFileSync(frontendDirectory + '/index.html'));
  }
  const asset = frontendAsset(pathname);
  if (asset) {
    res.setHeader('content-type', asset.type);
    return res.end(asset.body);
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(pathname === '/api/config' ? { roles: [], environments: [] } : []));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  for (const name of ['app-workspace', 'app-playback', 'app-management']) {
    const result = await page.evaluate<{ passed: number; failed?: string }>(
      readFileSync(new URL(`./${name}.browser.js`, import.meta.url), 'utf8'),
    );
    console.log(`${name}: ${result.passed} checks${result.failed ? `; FAILED: ${result.failed}` : ' passed'}`);
    if (result.failed) {
      console.error(JSON.stringify(result));
      process.exitCode = 1;
    }
  }
  if (errors.length) {
    console.error(errors);
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
