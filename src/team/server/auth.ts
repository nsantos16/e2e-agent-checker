import { createClerkClient } from '@clerk/backend';
import { randomUUID } from 'node:crypto';
import type { TeamConfig } from './config.ts';
import type { TeamDatabase, AuthenticatedActor } from './database.ts';
import { ApiError, forbidden } from './errors.ts';

export type VerifiedIdentity = {
  userId: string;
  orgId: string;
  sessionId: string;
  name: string;
};
export interface IdentityProvider {
  authenticate(request: Request): Promise<VerifiedIdentity>;
  sessions(
    userId: string,
  ): Promise<Array<{ id: string; status: string; lastActiveAt: number }>>;
  revokeSession(sessionId: string): Promise<void>;
}
export function clerkIdentity(config: TeamConfig): IdentityProvider {
  const clerk = createClerkClient({
    secretKey: config.clerkSecretKey,
    publishableKey: config.clerkPublishableKey,
  });
  return {
    async authenticate(request) {
      try {
        const state = await clerk.authenticateRequest(request, {
          authorizedParties: [config.publicUrl],
          acceptsToken: 'session_token',
        });
        const auth = state.toAuth();
        if (!auth?.userId || !auth.sessionId)
          throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
        if (auth.orgId !== config.clerkOrganizationId) throw forbidden();
        // The small pilot checks provider state on every request, including revocation.
        const [session, memberships] = await Promise.all([
          clerk.sessions.getSession(auth.sessionId),
          clerk.organizations.getOrganizationMembershipList({
            organizationId: auth.orgId,
            userId: [auth.userId],
            limit: 1,
          }),
        ]);
        const membership = memberships.data[0];
        if (
          session.status !== 'active' ||
          session.userId !== auth.userId ||
          !membership
        )
          throw forbidden();
        return {
          userId: auth.userId,
          orgId: auth.orgId,
          sessionId: auth.sessionId,
          name:
            [
              membership.publicUserData?.firstName,
              membership.publicUserData?.lastName,
            ]
              .filter(Boolean)
              .join(' ') || 'Team member',
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          503,
          'IDENTITY_UNAVAILABLE',
          'Authentication could not be verified. Try again.',
        );
      }
    },
    async sessions(userId) {
      const result = await clerk.sessions.getSessionList({
        userId,
        limit: 100,
      });
      return result.data.map((s) => ({
        id: s.id,
        status: s.status,
        lastActiveAt: s.lastActiveAt,
      }));
    },
    async revokeSession(sessionId) {
      await clerk.sessions.revokeSession(sessionId);
    },
  };
}

export async function resolveActor(
  db: TeamDatabase,
  identity: VerifiedIdentity,
  allowedOrg: string,
): Promise<AuthenticatedActor> {
  if (identity.orgId !== allowedOrg) throw forbidden();
  return db.transaction().execute(async (tx) => {
    const org = await tx
      .selectFrom('organizations')
      .selectAll()
      .where('clerk_org_id', '=', allowedOrg)
      .executeTakeFirst();
    if (!org) throw forbidden();
    let user = await tx
      .selectFrom('users')
      .selectAll()
      .where('clerk_user_id', '=', identity.userId)
      .executeTakeFirst();
    if (!user) {
      await tx
        .insertInto('users')
        .values({
          id: randomUUID(),
          clerk_user_id: identity.userId,
          name: identity.name,
        })
        .onConflict((c) => c.column('clerk_user_id').doNothing())
        .execute();
      user = await tx
        .selectFrom('users')
        .selectAll()
        .where('clerk_user_id', '=', identity.userId)
        .executeTakeFirstOrThrow();
    }
    if (user.disabled) throw forbidden();
    await tx
      .insertInto('memberships')
      .values({ org_id: org.id, user_id: user.id, role: 'member' })
      .onConflict((c) => c.columns(['org_id', 'user_id']).doNothing())
      .execute();
    const member = await tx
      .selectFrom('memberships')
      .selectAll()
      .where('org_id', '=', org.id)
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow();
    if (member.disabled) throw forbidden();
    await tx
      .insertInto('auth_sessions')
      .values({
        session_id: identity.sessionId,
        user_id: user.id,
        last_seen_at: new Date(),
      })
      .onConflict((c) =>
        c.column('session_id').doUpdateSet({ last_seen_at: new Date() }),
      )
      .execute();
    const session = await tx
      .selectFrom('auth_sessions')
      .selectAll()
      .where('session_id', '=', identity.sessionId)
      .executeTakeFirstOrThrow();
    if (session.revoked || session.user_id !== user.id) throw forbidden();
    return {
      userId: user.id,
      orgId: org.id,
      role: member.role,
      name: user.name,
      organizationName: org.name,
      sessionId: identity.sessionId,
      clerkUserId: identity.userId,
    };
  });
}
