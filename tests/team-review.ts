// Local-only review server. This entrypoint is excluded from the production image.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { teamFixture } from './team-fixtures.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = root + '/dist/team-review';
await build({
  configFile: false,
  root: root + '/tests/team-ui',
  logLevel: 'warn',
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: root + '/src/team/client/routes',
      generatedRouteTree: root + '/src/team/client/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
  ],
  build: { outDir: output, emptyOutDir: true },
});
const fixture = await teamFixture({ staticRoot: output });
try {
  await fixture.initialize();
  for (let i = 1; i <= 28; i++) {
    const result = await fixture.app.inject({
      method: 'POST',
      url: '/api/team/cases',
      headers: { authorization: 'Bearer member' },
      payload: {
        id: randomUUID(),
        data: {
          title: `e2e-agent-seed-${String(i).padStart(2, '0')}`,
          project: 'LOCAL',
          status: 'active',
          description: 'Disposable review data.',
          steps: [
            {
              action: 'Open the shared case workspace.',
              expectedResult: 'The permitted case catalog is visible.',
            },
          ],
        },
      },
    });
    if (result.statusCode !== 201)
      throw new Error('Review fixture seed failed.');
  }
  const url = await fixture.app.listen({
    host: '127.0.0.1',
    port: Number(process.env.TEAM_REVIEW_PORT ?? 4210),
  });
  fixture.config.publicUrl = url;
  console.log(`Local team review: ${url}/`);
  console.log(
    'Real team API and disposable PostgreSQL; fixture identities, no live Clerk authentication.',
  );
  console.log('Stop this process to delete its disposable database.');
} catch (error) {
  await fixture.close();
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await fixture.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
