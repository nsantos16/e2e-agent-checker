import { fileURLToPath } from 'node:url';
import { readTeamConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { clerkIdentity } from './auth.ts';
import { createTeamApp } from './app.ts';

const config = readTeamConfig();
const { db } = openDatabase(config.databaseUrl);
const app = await createTeamApp({
  db,
  config,
  identity: clerkIdentity(config),
  logger: true,
  staticRoot: config.serveUi
    ? fileURLToPath(new URL('../../../dist/team', import.meta.url))
    : undefined,
});
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.destroy();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await stop();
  throw error;
}
