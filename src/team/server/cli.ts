import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { openDatabase } from './database.ts';
import { migrate } from './migrate.ts';
import { createCase } from './cases.ts';
import { caseDraftSchema, roleSchema } from '../contracts.ts';

const connection = z.string().min(1).parse(process.env.TEAM_DATABASE_URL);
const { db, pool } = openDatabase(connection);
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'migrate') {
    await migrate(pool);
    console.log('Team database migrations applied.');
  } else if (command === 'member') {
    const [clerkOrgId, clerkUserId, role, name] = z
      .tuple([
        z.string().regex(/^org_/),
        z.string().regex(/^user_/),
        roleSchema,
        z.string().min(1),
      ])
      .parse(args);
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('organizations')
        .values({
          id: randomUUID(),
          clerk_org_id: clerkOrgId,
          name: 'Checker team',
        })
        .onConflict((c) => c.column('clerk_org_id').doNothing())
        .execute();
      await tx
        .insertInto('users')
        .values({ id: randomUUID(), clerk_user_id: clerkUserId, name })
        .onConflict((c) => c.column('clerk_user_id').doUpdateSet({ name }))
        .execute();
      const org = await tx
        .selectFrom('organizations')
        .selectAll()
        .where('clerk_org_id', '=', clerkOrgId)
        .executeTakeFirstOrThrow();
      const user = await tx
        .selectFrom('users')
        .selectAll()
        .where('clerk_user_id', '=', clerkUserId)
        .executeTakeFirstOrThrow();
      if (user.disabled)
        throw new Error(
          'Deleted identities cannot be re-enabled by member provisioning.',
        );
      await tx
        .insertInto('memberships')
        .values({ org_id: org.id, user_id: user.id, role })
        .onConflict((c) =>
          c
            .columns(['org_id', 'user_id'])
            .doUpdateSet({ role, disabled: false }),
        )
        .execute();
      await tx
        .insertInto('audit_events')
        .values({
          id: randomUUID(),
          org_id: org.id,
          actor_id: null,
          action: 'member.provisioned.cli',
          resource_id: user.id,
          created_at: new Date(),
        })
        .execute();
    });
    console.log(
      'Member provisioned. Clerk membership is also required at sign-in.',
    );
  } else if (command === 'import-case') {
    const [clerkOrgId, clerkUserId, file] = z
      .tuple([z.string(), z.string(), z.string()])
      .parse(args);
    const legacy = z
      .object({
        id: z.number().int().positive(),
        project: z.string().regex(/^[A-Z0-9_]{1,32}$/),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(file, 'utf8')));
    const data = caseDraftSchema.parse({
      project: legacy.project,
      title: legacy.title,
      description: legacy.description ?? '',
      preconditions: legacy.preconditions ?? '',
      suitePath: legacy.suite_path ?? '',
      priority: legacy.priority ?? 0,
      severity: legacy.severity ?? 0,
      tags: legacy.tags ?? [],
      status: legacy.status ?? 'draft',
      steps: z
        .array(z.record(z.string(), z.unknown()))
        .parse(legacy.steps ?? [])
        .map((s) => ({
          action: s.action ?? '',
          expectedResult: s.expected_result ?? '',
          data: s.data ?? '',
        })),
    });
    const member = await db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .innerJoin('organizations', 'organizations.id', 'memberships.org_id')
      .select([
        'users.id as userId',
        'memberships.org_id as orgId',
        'memberships.role',
        'users.name',
        'organizations.name as organizationName',
      ])
      .where('clerk_user_id', '=', clerkUserId)
      .where('clerk_org_id', '=', clerkOrgId)
      .where('users.disabled', '=', false)
      .where('memberships.disabled', '=', false)
      .executeTakeFirstOrThrow();
    // Stable UUID makes rehearsals repeatable; changed source conflicts instead of overwriting.
    const digest = createHash('sha256')
      .update(`${clerkOrgId}:${legacy.project}:${legacy.id}`)
      .digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const result = await createCase(
      db,
      { ...member, clerkUserId, sessionId: 'cli' },
      { id, data },
      true,
    );
    console.log(
      `Imported ${legacy.project}-${legacy.id} as ${result.id}; historical author remains unknown.`,
    );
  } else
    throw new Error(
      'Usage: team:db migrate | member <org_id> <user_id> <role> <name> | import-case <org_id> <user_id> <file>',
    );
} finally {
  await db.destroy();
  // migrate uses the raw pool, so Kysely may never have initialized its driver.
  if (!pool.ending) await pool.end();
}
