import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { canEdit, teamCaseSchema, type CaseDraft } from '../contracts.ts';
import type { AuthenticatedActor, Database, TeamDatabase } from './database.ts';
import { ApiError, forbidden } from './errors.ts';
import { lockActorAccess } from './access.ts';

export const toCase = (row: Database['cases']) =>
  teamCaseSchema.parse({
    ...row.data,
    id: row.id,
    orgId: row.org_id,
    revision: row.revision,
    createdByUserId: row.created_by,
    updatedByUserId: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
async function assertWriter(
  tx: Transaction<Database>,
  actor: AuthenticatedActor,
) {
  const member = await lockActorAccess(tx, actor);
  if (!canEdit(member.role)) throw forbidden();
}
export async function listCases(
  db: TeamDatabase,
  actor: AuthenticatedActor,
  input: { search: string; limit: number; after?: string },
) {
  let query = db
    .selectFrom('cases')
    .selectAll()
    .where('org_id', '=', actor.orgId)
    .orderBy('id')
    .limit(input.limit + 1);
  if (input.after) query = query.where('id', '>', input.after);
  if (input.search)
    query = query.where(
      sql<boolean>`strpos(lower(data->>'title'), lower(${input.search})) > 0`,
    );
  const rows = await query.execute();
  const items = rows.slice(0, input.limit).map(toCase);
  return {
    items,
    nextCursor: rows.length > input.limit ? items.at(-1)!.id : null,
  };
}
export async function getCase(
  db: TeamDatabase,
  actor: AuthenticatedActor,
  id: string,
) {
  const row = await db
    .selectFrom('cases')
    .selectAll()
    .where('org_id', '=', actor.orgId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Case not found.');
  return toCase(row);
}
export async function createCase(
  db: TeamDatabase,
  actor: AuthenticatedActor,
  input: { id: string; data: CaseDraft },
  imported = false,
) {
  return db.transaction().execute(async (tx) => {
    await assertWriter(tx, actor);
    const hash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.orgId}:${actor.userId}:${input.id}`}, 0))`.execute(
      tx,
    );
    const previous = await tx
      .selectFrom('idempotency_receipts')
      .selectAll()
      .where('org_id', '=', actor.orgId)
      .where('actor_id', '=', actor.userId)
      .where('key', '=', input.id)
      .executeTakeFirst();
    if (previous) {
      if (previous.request_hash !== hash)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This creation ID was used for different content.',
        );
      return previous.response;
    }
    const now = new Date();
    const row = await tx
      .insertInto('cases')
      .values({
        id: input.id,
        org_id: actor.orgId,
        data: input.data,
        revision: 1,
        created_by: imported ? null : actor.userId,
        updated_by: imported ? null : actor.userId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((c) => c.columns(['org_id', 'id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new ApiError(409, 'ID_CONFLICT', 'This case ID already exists.');
    const result = toCase(row);
    await tx
      .insertInto('case_versions')
      .values({
        org_id: actor.orgId,
        case_id: row.id,
        revision: 1,
        body: result,
      })
      .execute();
    await tx
      .insertInto('audit_events')
      .values({
        id: randomUUID(),
        org_id: actor.orgId,
        actor_id: actor.userId,
        action: imported ? 'case.imported' : 'case.created',
        resource_id: row.id,
        created_at: now,
      })
      .execute();
    await tx
      .insertInto('idempotency_receipts')
      .values({
        org_id: actor.orgId,
        actor_id: actor.userId,
        key: input.id,
        request_hash: hash,
        response: result,
      })
      .execute();
    return result;
  });
}
export async function updateCase(
  db: TeamDatabase,
  actor: AuthenticatedActor,
  id: string,
  input: { expectedRevision: number; data: CaseDraft },
) {
  return db.transaction().execute(async (tx) => {
    await assertWriter(tx, actor);
    const row = await tx
      .updateTable('cases')
      .set({
        data: input.data,
        revision: input.expectedRevision + 1,
        updated_by: actor.userId,
        updated_at: new Date(),
      })
      .where('org_id', '=', actor.orgId)
      .where('id', '=', id)
      .where('revision', '=', input.expectedRevision)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      const exists = await tx
        .selectFrom('cases')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      throw exists
        ? new ApiError(
            409,
            'REVISION_CONFLICT',
            'This case changed. Reload and reapply your edits.',
          )
        : new ApiError(404, 'NOT_FOUND', 'Case not found.');
    }
    const result = toCase(row);
    await tx
      .insertInto('case_versions')
      .values({
        org_id: actor.orgId,
        case_id: row.id,
        revision: row.revision,
        body: result,
      })
      .execute();
    await tx
      .insertInto('audit_events')
      .values({
        id: randomUUID(),
        org_id: actor.orgId,
        actor_id: actor.userId,
        action: 'case.updated',
        resource_id: row.id,
        created_at: new Date(),
      })
      .execute();
    return result;
  });
}
