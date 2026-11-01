import type { Transaction } from 'kysely';
import type { AuthenticatedActor, Database } from './database.ts';
import { forbidden } from './errors.ts';

// Serialize writes with local removals/revocations, including a change between
// the HTTP authentication check and the domain transaction.
export async function lockActorAccess(
  tx: Transaction<Database>,
  actor: AuthenticatedActor,
) {
  const user = await tx
    .selectFrom('users')
    .selectAll()
    .where('id', '=', actor.userId)
    .forShare()
    .executeTakeFirst();
  if (!user || user.disabled) throw forbidden();
  const member = await tx
    .selectFrom('memberships')
    .selectAll()
    .where('org_id', '=', actor.orgId)
    .where('user_id', '=', actor.userId)
    .forShare()
    .executeTakeFirst();
  if (!member || member.disabled) throw forbidden();
  // The trusted database CLI is not a browser login and has no Clerk session.
  if (actor.sessionId !== 'cli') {
    const session = await tx
      .selectFrom('auth_sessions')
      .selectAll()
      .where('session_id', '=', actor.sessionId)
      .where('user_id', '=', actor.userId)
      .forShare()
      .executeTakeFirst();
    if (!session || session.revoked) throw forbidden();
  }
  return member;
}
