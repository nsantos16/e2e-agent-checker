import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { openDatabase } from '../src/team/server/database.ts';
import { migrate } from '../src/team/server/migrate.ts';
import { createTeamApp } from '../src/team/server/app.ts';
import type {
  IdentityProvider,
  VerifiedIdentity,
} from '../src/team/server/auth.ts';
import type { TeamConfig } from '../src/team/server/config.ts';
import type { Role } from '../src/team/contracts.ts';
import { ApiError } from '../src/team/server/errors.ts';

// A separate database is created and dropped; the supplied database is never migrated.
export async function teamFixture(options: { staticRoot?: string } = {}) {
  if (!process.env.TEAM_TEST_DATABASE_URL)
    throw new Error(
      'Set TEAM_TEST_DATABASE_URL to a disposable PostgreSQL instance with CREATEDB permission.',
    );
  const admin = new Pool({
    connectionString: process.env.TEAM_TEST_DATABASE_URL,
  });
  const databaseName = `checker_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(process.env.TEAM_TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  const { db, pool } = openDatabase(url.href);
  const config: TeamConfig = {
    databaseUrl: url.href,
    publicUrl: 'http://127.0.0.1:5174',
    host: '127.0.0.1',
    port: 4200,
    clerkPublishableKey: 'pk_test_fixture',
    clerkSecretKey: 'sk_test_fixture',
    clerkOrganizationId: 'org_fixture',
    serveUi: false,
    webhookSecret: `whsec_${Buffer.from('fixture-signing-key-for-tests-only').toString('base64')}`,
  };
  const identities = new Map<string, VerifiedIdentity>();
  const revoked = new Set<string>();
  let providerDown = false;
  const identity: IdentityProvider = {
    async authenticate(request) {
      if (providerDown)
        throw new ApiError(
          503,
          'IDENTITY_UNAVAILABLE',
          'Authentication could not be verified.',
        );
      const value = identities.get(
        request.headers.get('authorization')?.slice(7) ?? '',
      );
      if (!value || revoked.has(value.sessionId))
        throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
      return value;
    },
    async sessions(userId) {
      return [...identities.values()]
        .filter((i) => i.userId === userId)
        .map((i) => ({
          id: i.sessionId,
          status: revoked.has(i.sessionId) ? 'revoked' : 'active',
          lastActiveAt: 1_700_000_000_000,
        }));
    },
    async revokeSession(id) {
      revoked.add(id);
    },
  };
  const apps: Awaited<ReturnType<typeof createTeamApp>>[] = [];
  const app = await createTeamApp({
    db,
    identity,
    config,
    staticRoot: options.staticRoot,
  });
  apps.push(app);
  const orgId = randomUUID();
  const users = new Map<string, string>();
  async function initialize() {
    await migrate(pool);
    await db
      .insertInto('organizations')
      .values({
        id: orgId,
        clerk_org_id: config.clerkOrganizationId,
        name: 'Test team',
      })
      .execute();
    for (const role of ['owner', 'admin', 'member', 'viewer'] as Role[])
      await addMember(role, role);
  }
  async function addMember(
    token: string,
    role: Role,
    org = orgId,
    clerkOrg = config.clerkOrganizationId,
  ) {
    const id = randomUUID();
    identities.set(token, {
      userId: `user_${token}`,
      orgId: clerkOrg,
      sessionId: `sess_${token}`,
      name: token,
    });
    await db
      .insertInto('users')
      .values({ id, clerk_user_id: `user_${token}`, name: token })
      .execute();
    await db
      .insertInto('memberships')
      .values({ org_id: org, user_id: id, role })
      .execute();
    users.set(token, id);
    return id;
  }
  return {
    db,
    pool,
    config,
    identity,
    identities,
    revoked,
    app,
    orgId,
    users,
    initialize,
    addMember,
    setProviderDown(value: boolean) {
      providerDown = value;
    },
    async anotherApp(override: Partial<TeamConfig> = {}, staticRoot?: string) {
      const next = await createTeamApp({
        db,
        identity,
        config: { ...config, ...override },
        staticRoot,
      });
      apps.push(next);
      return next;
    },
    async close() {
      await Promise.all(apps.map((a) => a.close()));
      await db.destroy();
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
