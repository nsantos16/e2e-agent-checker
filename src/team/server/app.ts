import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { Webhook } from 'svix';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  actorSchema,
  caseListRequest,
  createCaseRequest,
  updateCaseRequest,
  roleSchema,
} from '../contracts.ts';
import { resolveActor, type IdentityProvider } from './auth.ts';
import type { TeamConfig } from './config.ts';
import type { AuthenticatedActor, TeamDatabase } from './database.ts';
import { ApiError, forbidden } from './errors.ts';
import { createCase, getCase, listCases, updateCase } from './cases.ts';
import { serveTeamBuild } from './static.ts';
import { lockActorAccess } from './access.ts';

export async function createTeamApp(options: {
  db: TeamDatabase;
  identity: IdentityProvider;
  config: TeamConfig;
  staticRoot?: string;
  logger?: boolean;
}) {
  const { db, identity, config } = options;
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.authorization', 'req.headers.cookie'] }
      : false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 15000,
  });
  await app.register(cors, { origin: config.publicUrl, credentials: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          code: 'INVALID_INPUT',
          error: 'Check the submitted fields.',
          issues: error.issues.map(({ path, message }) => ({ path, message })),
        });
    if (error instanceof ApiError)
      return reply
        .code(error.status)
        .send({ code: error.code, error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({
          code: 'INVALID_REQUEST',
          error:
            status === 429
              ? 'Too many requests. Try again shortly.'
              : 'Invalid request.',
        });
    request.log.error(
      { code: (error as { code?: string }).code },
      'Team request failed',
    );
    return reply
      .code(500)
      .send({
        code: 'INTERNAL_ERROR',
        error: 'The request could not be completed.',
      });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'same-origin');
    if (
      reply.getHeader('content-type')?.toString().includes('application/json')
    )
      reply.header('cache-control', 'no-store');
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const result =
        await sql`select 1 from checker.migrations where name = '001.sql'`.execute(
          db,
        );
      if (!result.rows.length)
        return reply.code(503).send({ status: 'unavailable' });
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/api/team/config', async () => ({
    clerkPublishableKey: config.clerkPublishableKey,
  }));
  // Signature verification needs the exact bytes, not reserialized JSON.
  await app.register(async (hooks) => {
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => done(null, body),
    );
    hooks.post('/api/team/webhooks/clerk', async (request) => {
      if (!config.webhookSecret)
        throw new ApiError(
          503,
          'NOT_CONFIGURED',
          'Webhook verification is not configured.',
        );
      let event: { type: string; data: Record<string, unknown> };
      const headers = z
        .object({
          'svix-id': z.string(),
          'svix-timestamp': z.string(),
          'svix-signature': z.string(),
        })
        .parse(request.headers);
      try {
        new Webhook(config.webhookSecret).verify(
          request.body as string,
          headers,
        );
        event = z
          .object({ type: z.string(), data: z.record(z.string(), z.unknown()) })
          .parse(JSON.parse(request.body as string));
      } catch {
        throw new ApiError(
          401,
          'INVALID_SIGNATURE',
          'Invalid webhook signature.',
        );
      }
      await db.transaction().execute(async (tx) => {
        const receipt = await tx
          .insertInto('webhook_receipts')
          .values({
            id: headers['svix-id'],
            type: event.type,
            received_at: new Date(),
          })
          .onConflict((c) => c.column('id').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!receipt) return;
        if (event.type === 'user.deleted') {
          const data = z.object({ id: z.string() }).parse(event.data);
          // Tombstone even an identity whose first-login request has not arrived.
          await tx
            .insertInto('users')
            .values({
              id: randomUUID(),
              clerk_user_id: data.id,
              name: 'Former member',
              disabled: true,
            })
            .onConflict((c) =>
              c.column('clerk_user_id').doUpdateSet({ disabled: true }),
            )
            .execute();
        }
        if (event.type === 'organizationMembership.deleted') {
          const data = z
            .object({
              organization: z.object({ id: z.string() }),
              public_user_data: z.object({ user_id: z.string() }),
            })
            .parse(event.data);
          const org = await tx
            .selectFrom('organizations')
            .selectAll()
            .where('clerk_org_id', '=', data.organization.id)
            .executeTakeFirst();
          if (org) {
            await tx
              .insertInto('users')
              .values({
                id: randomUUID(),
                clerk_user_id: data.public_user_data.user_id,
                name: 'Team member',
              })
              .onConflict((c) => c.column('clerk_user_id').doNothing())
              .execute();
            const user = await tx
              .selectFrom('users')
              .selectAll()
              .where('clerk_user_id', '=', data.public_user_data.user_id)
              .executeTakeFirstOrThrow();
            await tx
              .insertInto('memberships')
              .values({
                org_id: org.id,
                user_id: user.id,
                role: 'member',
                disabled: true,
              })
              .onConflict((c) =>
                c
                  .columns(['org_id', 'user_id'])
                  .doUpdateSet({ disabled: true }),
              )
              .execute();
          }
        }
        // Creation/update webhooks never grant access or undo a local denial.
      });
      return { received: true };
    });
  });
  await app.register(
    async (api) => {
      api.decorateRequest('teamActor', null);
      api.addHook('preHandler', async (request) => {
        if (
          request.headers.origin &&
          request.headers.origin !== config.publicUrl
        )
          throw forbidden();
        // API uses explicit bearer credentials; cookies alone cannot authorize writes.
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith('Bearer '))
          throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
        const verified = await identity.authenticate(
          new Request(config.publicUrl + request.url, {
            headers: { authorization },
          }),
        );
        request.teamActor = await resolveActor(
          db,
          verified,
          config.clerkOrganizationId,
        );
      });
      api.get('/me', async (request) => actorSchema.parse(request.teamActor));
      api.get('/cases', async (request) =>
        listCases(db, request.teamActor!, caseListRequest.parse(request.query)),
      );
      api.get('/cases/:id', async (request) =>
        getCase(
          db,
          request.teamActor!,
          z.object({ id: z.uuid() }).parse(request.params).id,
        ),
      );
      api.post('/cases', async (request, reply) =>
        reply
          .code(201)
          .send(
            await createCase(
              db,
              request.teamActor!,
              createCaseRequest.parse(request.body),
            ),
          ),
      );
      api.patch('/cases/:id', async (request) =>
        updateCase(
          db,
          request.teamActor!,
          z.object({ id: z.uuid() }).parse(request.params).id,
          updateCaseRequest.parse(request.body),
        ),
      );
      api.get('/sessions', async (request) => ({
        items: (await identity.sessions(request.teamActor!.clerkUserId)).map(
          (session) => ({
            ...session,
            current: session.id === request.teamActor!.sessionId,
          }),
        ),
      }));
      api.delete('/sessions/:id', async (request) => {
        const actor = request.teamActor!;
        const id = z
          .object({ id: z.string().max(200) })
          .parse(request.params).id;
        const sessions = await identity.sessions(actor.clerkUserId);
        if (!sessions.some((s) => s.id === id))
          throw new ApiError(404, 'NOT_FOUND', 'Session not found.');
        await db.transaction().execute(async (tx) => {
          await lockActorAccess(tx, actor);
          await tx
            .insertInto('auth_sessions')
            .values({
              session_id: id,
              user_id: actor.userId,
              last_seen_at: new Date(),
              revoked: true,
            })
            .onConflict((c) =>
              c.column('session_id').doUpdateSet({ revoked: true }),
            )
            .execute();
          await tx
            .insertInto('audit_events')
            .values({
              id: randomUUID(),
              org_id: actor.orgId,
              actor_id: actor.userId,
              action: 'session.revoked',
              resource_id: id,
              created_at: new Date(),
            })
            .execute();
        });
        await identity.revokeSession(id);
        return { revoked: true, current: id === actor.sessionId };
      });
      api.get('/members', async (request) => {
        const actor = request.teamActor!;
        if (!['admin', 'owner'].includes(actor.role)) throw forbidden();
        return {
          items: await db
            .selectFrom('memberships')
            .innerJoin('users', 'users.id', 'memberships.user_id')
            .select([
              'users.id',
              'users.name',
              'memberships.role',
              'memberships.disabled',
            ])
            .where('org_id', '=', actor.orgId)
            .orderBy('users.id')
            .limit(100)
            .execute(),
        };
      });
      api.patch('/members/:id', async (request) => {
        const actor = request.teamActor!;
        const userId = z.object({ id: z.uuid() }).parse(request.params).id;
        const change = z
          .object({
            role: roleSchema.exclude(['owner']),
            disabled: z.boolean(),
          })
          .strict()
          .parse(request.body);
        if (actor.role !== 'owner' || userId === actor.userId)
          throw forbidden();
        await db.transaction().execute(async (tx) => {
          const caller = await lockActorAccess(tx, actor);
          if (caller.role !== 'owner') throw forbidden();
          const result = await tx
            .updateTable('memberships')
            .set(change)
            .where('org_id', '=', actor.orgId)
            .where('user_id', '=', userId)
            .where('role', '!=', 'owner')
            .returning('user_id')
            .executeTakeFirst();
          if (!result)
            throw new ApiError(
              404,
              'NOT_FOUND',
              'Member not found or is an owner.',
            );
          await tx
            .insertInto('audit_events')
            .values({
              id: randomUUID(),
              org_id: actor.orgId,
              actor_id: actor.userId,
              action: change.disabled ? 'member.disabled' : 'member.updated',
              resource_id: userId,
              created_at: new Date(),
            })
            .execute();
        });
        return { updated: true };
      });
    },
    { prefix: '/api/team' },
  );
  if (options.staticRoot) await serveTeamBuild(app, options.staticRoot);
  return app;
}
declare module 'fastify' {
  interface FastifyRequest {
    teamActor: AuthenticatedActor | null;
  }
}
