import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { canEdit, teamRunSchema, type RunData } from '../contracts.ts';
import type { TeamDatabase, AuthenticatedActor, Database } from './database.ts';
import { lockActorAccess } from './access.ts';
import { ApiError, forbidden } from './errors.ts';

const toRun = (row: Database['runs'], name: string) =>
  teamRunSchema.parse({
    ...row.data,
    id: row.id,
    orgId: row.org_id,
    initiatedBy: { id: row.initiated_by, name },
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });
function decodeCursor(cursor: string) {
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString()),
    );
  } catch {
    throw new ApiError(
      400,
      'INVALID_CURSOR',
      'Invalid run page. Return to the first page.',
    );
  }
}
export async function listRuns(
  db: TeamDatabase,
  actor: AuthenticatedActor,
  input: { userId?: string; after?: string; search?: string; limit: number },
) {
  const cursor = input.after ? decodeCursor(input.after) : undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (tx) => {
      let scope = tx.selectFrom('runs').where('runs.org_id', '=', actor.orgId);
      if (input.userId)
        scope = scope.where('runs.initiated_by', '=', input.userId);
      if (input.search)
        scope = scope.where(
          sql<boolean>`strpos(lower(concat_ws(' ', data->>'title', data->>'project', data->>'caseLabel', data->>'model')), lower(${input.search})) > 0`,
        );
      let query = scope
        .innerJoin('users', 'users.id', 'runs.initiated_by')
        .selectAll('runs')
        .select('users.name as user_name')
        .orderBy('runs.created_at', 'desc')
        .orderBy('runs.id', 'desc')
        .limit(input.limit + 1);
      if (cursor)
        query = query.where(
          sql<boolean>`(runs.created_at, runs.id) < (${new Date(cursor.at)}, ${cursor.id}::uuid)`,
        );
      const rows = await query.execute();
      const stats = await scope
        .select([
          sql<number>`count(*)::integer`.as('total'),
          sql<number>`count(*) filter (where data->>'status' in ('queued', 'running', 'cancelling'))::integer`.as(
            'active',
          ),
          sql<number>`count(*) filter (where data->>'status' = 'done' and data->>'outcome' = 'pass')::integer`.as(
            'passed',
          ),
          sql<number>`count(*) filter (where data->>'status' = 'failed' or (data->>'status' = 'done' and data->>'outcome' = 'fail'))::integer`.as(
            'failed',
          ),
        ])
        .executeTakeFirstOrThrow();
      // Minimal directory for filtering, available to viewers without exposing admin fields.
      // Retain former members so historical runs remain attributable and filterable.
      const users = await tx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select(['users.id', 'users.name'])
        .where('memberships.org_id', '=', actor.orgId)
        .orderBy('users.name')
        .orderBy('users.id')
        .execute();
      const items = rows
        .slice(0, input.limit)
        .map((row) => toRun(row, row.user_name));
      const last = items.at(-1);
      return {
        items,
        users,
        stats,
        nextCursor:
          rows.length > input.limit && last
            ? Buffer.from(
                JSON.stringify({ at: last.createdAt, id: last.id }),
              ).toString('base64url')
            : null,
      };
    });
}
export async function getRun(
  db: TeamDatabase,
  actor: AuthenticatedActor,
  id: string,
) {
  const row = await db
    .selectFrom('runs')
    .innerJoin('users', 'users.id', 'runs.initiated_by')
    .selectAll('runs')
    .select('users.name as user_name')
    .where('runs.org_id', '=', actor.orgId)
    .where('runs.id', '=', id)
    .executeTakeFirst();
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Run not found.');
  return toRun(row, row.user_name);
}
export async function publishRun(
  db: TeamDatabase,
  actor: AuthenticatedActor,
  input: { id: string; data: RunData; expectedRevision?: number },
) {
  return db.transaction().execute(async (tx) => {
    const member = await lockActorAccess(tx, actor);
    if (!canEdit(member.role)) throw forbidden();
    await sql`select pg_advisory_xact_lock(hashtextextended(${`run:${actor.orgId}:${input.id}`}, 0))`.execute(
      tx,
    );
    const previous = await tx
      .selectFrom('runs')
      .selectAll()
      .where('org_id', '=', actor.orgId)
      .where('id', '=', input.id)
      .forUpdate()
      .executeTakeFirst();
    if (previous && previous.initiated_by !== actor.userId) throw forbidden();
    if (input.expectedRevision === undefined && previous) {
      // Compare normalized JSON, independent of PostgreSQL jsonb key ordering.
      const same = Object.entries(input.data).every(
        ([key, value]) => previous.data[key as keyof RunData] === value,
      );
      if (same) return toRun(previous, actor.name);
      throw new ApiError(
        409,
        'RUN_EXISTS',
        'This run already exists. Publish an update with its revision.',
      );
    }
    if (input.expectedRevision !== undefined) {
      if (!previous) throw new ApiError(404, 'NOT_FOUND', 'Run not found.');
      if (previous.revision !== input.expectedRevision)
        throw new ApiError(
          409,
          'REVISION_CONFLICT',
          'This run changed. Reload its latest revision.',
        );
    }
    const now = new Date();
    const row = previous
      ? await tx
          .updateTable('runs')
          .set({
            data: input.data,
            revision: previous.revision + 1,
            updated_at: now,
          })
          .where('org_id', '=', actor.orgId)
          .where('id', '=', input.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await tx
          .insertInto('runs')
          .values({
            id: input.id,
            org_id: actor.orgId,
            initiated_by: actor.userId,
            data: input.data,
            revision: 1,
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
    await tx
      .insertInto('audit_events')
      .values({
        id: randomUUID(),
        org_id: actor.orgId,
        actor_id: actor.userId,
        action: previous ? 'run.updated' : 'run.published',
        resource_id: row.id,
        created_at: now,
      })
      .execute();
    return toRun(row, actor.name);
  });
}
