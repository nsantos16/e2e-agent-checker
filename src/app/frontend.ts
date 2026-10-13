import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('../..', import.meta.url).pathname;
export const frontendDirectory = join(root, 'dist/client');
const newestSource = (path: string): number => {
  const stat = statSync(path);
  return stat.isDirectory() ? Math.max(stat.mtimeMs, ...readdirSync(path).map((name) => newestSource(join(path, name)))) : stat.mtimeMs;
};
// Direct CLI and MCP startup also serve the current UI, without a separate dev server.
export async function ensureFrontend() {
  const entry = join(frontendDirectory, 'index.html');
  const inputs = ['src/app/client', 'vite.config.ts', 'package-lock.json'].map((path) => join(root, path));
  if (existsSync(entry) && inputs.every((path) => !existsSync(path) || newestSource(path) <= statSync(entry).mtimeMs)) return;
  const { build } = await import('vite');
  await build({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
}
export function frontendAsset(pathname: string): { body: Buffer; type: string } | null {
  const match = /^\/assets\/([\w.-]+\.(js|css))$/.exec(pathname);
  if (!match) return null;
  const path = join(frontendDirectory, 'assets', match[1]);
  if (!existsSync(path)) return null;
  return { body: readFileSync(path), type: match[2] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' };
}
