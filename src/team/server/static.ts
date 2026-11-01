import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// Vite emits immutable assets into one directory. Load the build at startup;
// requests can only address these files, never arbitrary filesystem paths.
export async function serveTeamBuild(app: FastifyInstance, root: string) {
  const index = await readFile(join(root, 'index.html'));
  const assets = new Map<string, { body: Buffer; type: string }>();
  const types: Record<string, string> = {
    js: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    webp: 'image/webp',
    woff2: 'font/woff2',
  };
  for (const file of await readdir(join(root, 'assets'), {
    withFileTypes: true,
  })) {
    const type = types[file.name.split('.').at(-1)!];
    if (file.isFile() && type)
      assets.set(file.name, {
        type,
        body: await readFile(join(root, 'assets', file.name)),
      });
  }
  app.get<{ Params: { name: string } }>(
    '/assets/:name',
    async (request, reply) => {
      const asset = assets.get(request.params.name);
      if (!asset)
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', error: 'Asset not found.' });
      return reply
        .type(asset.type)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(asset.body);
    },
  );
  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (
      request.method === 'GET' &&
      !pathname.startsWith('/api/') &&
      !pathname.startsWith('/health/') &&
      !pathname.includes('.')
    ) {
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(index);
    }
    return reply.code(404).send({ code: 'NOT_FOUND', error: 'Not found.' });
  });
}
