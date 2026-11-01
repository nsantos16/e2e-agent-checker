import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'svix';
import { teamFixture } from './team-fixtures.ts';
import { migrate } from '../src/team/server/migrate.ts';
import { caseDraftSchema } from '../src/team/contracts.ts';
import { readTeamConfig } from '../src/team/server/config.ts';
import { resolveActor } from '../src/team/server/auth.ts';
import { createCase } from '../src/team/server/cases.ts';
import { ApiError } from '../src/team/server/errors.ts';

test('team configuration rejects non-HTTPS remote origins and development keys in production', () => {
  const env = {
    TEAM_DATABASE_URL: 'postgres://localhost/fixture',
    TEAM_PUBLIC_URL: 'http://localhost:5174',
    TEAM_CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
    TEAM_CLERK_SECRET_KEY: 'sk_test_fixture',
    TEAM_CLERK_ORGANIZATION_ID: 'org_fixture',
  };
  assert.equal(readTeamConfig(env).publicUrl, 'http://localhost:5174');
  assert.throws(
    () => readTeamConfig({ ...env, TEAM_PUBLIC_URL: 'http://example.com' }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      readTeamConfig({ ...env, TEAM_PUBLIC_URL: 'https://example.com/path' }),
    /origin/,
  );
  assert.throws(
    () => readTeamConfig({ ...env, NODE_ENV: 'production' }),
    /production keys/,
  );
});

test(
  'team API persists and isolates cases, identities, revisions and sessions in PostgreSQL',
  { skip: !process.env.TEAM_TEST_DATABASE_URL },
  async (t) => {
    const f = await teamFixture();
    t.after(() => f.close());
    assert.equal((await f.app.inject('/health/ready')).statusCode, 503);
    await f.initialize();
    await migrate(f.pool);
    assert.equal((await f.app.inject('/health/ready')).statusCode, 200);
    const request = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      token = 'member',
      payload?: object,
    ) =>
      f.app.inject({
        method,
        url: `/api/team${path}`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    const data = caseDraftSchema.parse({ title: 'Team checkout' });
    let caseId: string;

    await t.test(
      'authentication fails closed; admission requires the approved organization',
      async () => {
        assert.equal((await f.app.inject('/api/team/cases')).statusCode, 401);
        assert.equal(
          (
            await f.app.inject({
              url: '/api/team/cases',
              headers: { cookie: '__session=fake' },
            })
          ).statusCode,
          401,
        );
        assert.equal(
          (await request('GET', '/cases', 'unknown')).statusCode,
          401,
        );
        f.identities.set('outsider', {
          userId: 'user_outsider',
          orgId: 'org_other',
          sessionId: 'sess_outsider',
          name: 'Outsider',
        });
        assert.equal(
          (await request('GET', '/cases', 'outsider')).statusCode,
          403,
        );
        f.setProviderDown(true);
        assert.equal((await request('GET', '/cases')).statusCode, 503);
        f.setProviderDown(false);
        assert.equal(
          (
            await f.app.inject({
              url: '/api/team/me',
              headers: {
                authorization: 'Bearer member',
                origin: 'https://untrusted.example',
              },
            })
          ).statusCode,
          403,
        );
        f.identities.set('newcomer', {
          userId: 'user_newcomer',
          orgId: f.config.clerkOrganizationId,
          sessionId: 'sess_newcomer',
          name: 'Newcomer',
        });
        const me = await request('GET', '/me', 'newcomer');
        assert.equal(me.statusCode, 200);
        assert.equal(me.json().role, 'member');
        assert.equal(
          (await request('GET', '/me', 'owner')).json().role,
          'owner',
        );
        assert.equal(me.headers['cache-control'], 'no-store');
        const cfg = (await f.app.inject('/api/team/config')).json();
        assert.deepEqual(Object.keys(cfg), ['clerkPublishableKey']);
      },
    );

    await t.test(
      'strict validation and server-side roles reject forged attribution and viewer writes',
      async () => {
        assert.equal(
          (
            await request('POST', '/cases', 'viewer', {
              id: randomUUID(),
              data,
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request('POST', '/cases', 'member', {
              id: randomUUID(),
              data,
              createdByUserId: f.users.get('owner'),
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await request('POST', '/cases', 'member', {
              id: randomUUID(),
              data: { ...data, status: 'active' },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await request('POST', '/cases', 'member', {
              id: randomUUID(),
              data: { ...data, title: ' ' },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (await request('GET', '/cases?limit=1000000')).statusCode,
          400,
        );
        assert.equal((await request('GET', '/members')).statusCode, 403);
      },
    );

    await t.test(
      'duplicate concurrent creates produce one row, version and audit event',
      async () => {
        caseId = randomUUID();
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            request('POST', '/cases', 'member', { id: caseId, data }),
          ),
        );
        assert.deepEqual(
          results.map((r) => r.statusCode),
          [201, 201, 201, 201],
        );
        assert.equal(results[0].json().createdByUserId, f.users.get('member'));
        assert.deepEqual(results[0].json(), results[3].json());
        assert.equal(
          (
            await request('POST', '/cases', 'member', {
              id: caseId,
              data: { ...data, title: 'Changed request' },
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (await request('POST', '/cases', 'admin', { id: caseId, data }))
            .statusCode,
          409,
        );
        const versions = await f.db
          .selectFrom('case_versions')
          .selectAll()
          .where('case_id', '=', caseId)
          .execute();
        const audits = await f.db
          .selectFrom('audit_events')
          .selectAll()
          .where('resource_id', '=', caseId)
          .execute();
        assert.equal(versions.length, 1);
        assert.equal(audits.length, 1);
      },
    );

    await t.test(
      'simultaneous edits have one winner and a rejected stale edit creates no version',
      async () => {
        const results = await Promise.all(
          ['member', 'admin'].map((token) =>
            request('PATCH', `/cases/${caseId}`, token, {
              expectedRevision: 1,
              data: { ...data, title: `Team checkout ${token}` },
            }),
          ),
        );
        assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
        assert.equal(
          (await request('GET', `/cases/${caseId}`, 'viewer')).json().revision,
          2,
        );
        assert.equal(
          (
            await f.db
              .selectFrom('case_versions')
              .selectAll()
              .where('case_id', '=', caseId)
              .execute()
          ).length,
          2,
        );
        assert.equal(
          (
            await f.db
              .selectFrom('audit_events')
              .selectAll()
              .where('resource_id', '=', caseId)
              .execute()
          ).length,
          2,
        );
      },
    );

    await t.test(
      'organization isolation applies to lists, direct IDs and edits',
      async () => {
        const otherOrg = randomUUID();
        await f.db
          .insertInto('organizations')
          .values({
            id: otherOrg,
            clerk_org_id: 'org_other',
            name: 'Other team',
          })
          .execute();
        await f.addMember('other_member', 'member', otherOrg, 'org_other');
        const other = await f.anotherApp({ clerkOrganizationId: 'org_other' });
        const headers = { authorization: 'Bearer other_member' };
        const list = await other.inject({ url: '/api/team/cases', headers });
        assert.deepEqual(list.json().items, []);
        assert.equal(
          (await other.inject({ url: `/api/team/cases/${caseId}`, headers }))
            .statusCode,
          404,
        );
        assert.equal(
          (
            await other.inject({
              method: 'PATCH',
              url: `/api/team/cases/${caseId}`,
              headers,
              payload: { expectedRevision: 2, data },
            })
          ).statusCode,
          404,
        );
        const own = await other.inject({
          method: 'POST',
          url: '/api/team/cases',
          headers,
          payload: { id: caseId, data: { ...data, title: 'Other org' } },
        });
        assert.equal(own.statusCode, 201);
        assert.notEqual(
          (await request('GET', `/cases/${caseId}`)).json().title,
          'Other org',
        );
      },
    );

    await t.test(
      'cursor pagination is bounded and title matching treats SQL characters literally',
      async () => {
        for (let i = 0; i < 4; i++)
          assert.equal(
            (
              await request('POST', '/cases', 'member', {
                id: randomUUID(),
                data: { ...data, title: `Page %' ${i}` },
              })
            ).statusCode,
            201,
          );
        const first = (await request('GET', '/cases?limit=2')).json();
        const second = (
          await request('GET', `/cases?limit=2&after=${first.nextCursor}`)
        ).json();
        assert.equal(first.items.length, 2);
        assert.equal(second.items.length, 2);
        assert.equal(
          new Set(
            [...first.items, ...second.items].map((c: { id: string }) => c.id),
          ).size,
          4,
        );
        assert.equal(
          (
            await request('GET', `/cases?search=${encodeURIComponent("%' ")}`)
          ).json().items.length,
          4,
        );
        assert.equal(
          (
            await request(
              'GET',
              `/cases?search=${encodeURIComponent("' OR 1=1 --")}`,
            )
          ).json().items.length,
          0,
        );
      },
    );

    await t.test(
      'owner role changes and removals take effect without granting access on subsequent login',
      async () => {
        const memberId = await f.addMember('removable', 'member');
        assert.equal(
          (await request('GET', '/me', 'removable')).statusCode,
          200,
        );
        const payload = { role: 'viewer', disabled: false };
        assert.equal(
          (await request('PATCH', `/members/${memberId}`, 'admin', payload))
            .statusCode,
          403,
        );
        assert.equal(
          (await request('PATCH', `/members/${memberId}`, 'owner', payload))
            .statusCode,
          200,
        );
        assert.equal(
          (
            await request('POST', '/cases', 'removable', {
              id: randomUUID(),
              data,
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request('PATCH', `/members/${memberId}`, 'owner', {
              ...payload,
              disabled: true,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (await request('GET', '/cases', 'removable')).statusCode,
          403,
        );
        assert.equal(
          (await request('GET', '/me', 'removable')).statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              'PATCH',
              `/members/${f.users.get('owner')}`,
              'owner',
              payload,
            )
          ).statusCode,
          403,
        );
      },
    );

    await t.test(
      'Clerk deletion webhooks are signed, deduplicated and cannot be undone by stale create events',
      async () => {
        const send = async (
          type: string,
          data: object,
          id = `msg_${randomUUID()}`,
        ) => {
          const body = JSON.stringify({ type, data });
          const date = new Date();
          return f.app.inject({
            method: 'POST',
            url: '/api/team/webhooks/clerk',
            payload: body,
            headers: {
              'content-type': 'application/json',
              'svix-id': id,
              'svix-timestamp': String(Math.floor(date.getTime() / 1000)),
              'svix-signature': new Webhook(f.config.webhookSecret!).sign(
                id,
                date,
                body,
              ),
            },
          });
        };
        assert.equal(
          (
            await f.app.inject({
              method: 'POST',
              url: '/api/team/webhooks/clerk',
              payload: '{}',
              headers: {
                'content-type': 'application/json',
                'svix-id': 'fake',
                'svix-timestamp': '1',
                'svix-signature': 'fake',
              },
            })
          ).statusCode,
          401,
        );
        f.identities.set('deleted', {
          userId: 'user_deleted',
          orgId: f.config.clerkOrganizationId,
          sessionId: 'sess_deleted',
          name: 'Deleted',
        });
        const id = `msg_${randomUUID()}`;
        assert.equal(
          (await send('user.deleted', { id: 'user_deleted' }, id)).statusCode,
          200,
        );
        assert.equal(
          (await send('user.deleted', { id: 'user_deleted' }, id)).statusCode,
          200,
        );
        assert.equal(
          (await send('user.created', { id: 'user_deleted' })).statusCode,
          200,
        );
        assert.equal((await request('GET', '/me', 'deleted')).statusCode, 403);
        f.identities.set('removed_before_login', {
          userId: 'user_removed_before_login',
          orgId: f.config.clerkOrganizationId,
          sessionId: 'sess_removed_before_login',
          name: 'Removed',
        });
        const membership = {
          organization: { id: f.config.clerkOrganizationId },
          public_user_data: { user_id: 'user_removed_before_login' },
        };
        assert.equal(
          (await send('organizationMembership.deleted', membership)).statusCode,
          200,
        );
        assert.equal(
          (await send('organizationMembership.created', membership)).statusCode,
          200,
        );
        assert.equal(
          (await request('GET', '/me', 'removed_before_login')).statusCode,
          403,
        );
      },
    );

    await t.test(
      'session revocation is limited to the caller and persists a local denial',
      async () => {
        await f.addMember('session_owner', 'member');
        assert.equal(
          (await request('GET', '/sessions', 'session_owner')).json().items
            .length,
          1,
        );
        assert.equal(
          (await request('DELETE', '/sessions/sess_owner', 'session_owner'))
            .statusCode,
          404,
        );
        assert.equal(
          (
            await request(
              'DELETE',
              '/sessions/sess_session_owner',
              'session_owner',
            )
          ).statusCode,
          200,
        );
        f.revoked.delete('sess_session_owner'); // Simulate provider lag: the stored denial still wins.
        assert.equal(
          (await request('GET', '/me', 'session_owner')).statusCode,
          403,
        );
        const observation = await f.db
          .selectFrom('auth_sessions')
          .selectAll()
          .where('session_id', '=', 'sess_session_owner')
          .executeTakeFirstOrThrow();
        assert.equal(observation.revoked, true);
      },
    );

    await t.test(
      'writes recheck a previously authenticated actor after a local access change',
      async () => {
        const userId = await f.addMember('stale_actor', 'member');
        const actor = await resolveActor(
          f.db,
          f.identities.get('stale_actor')!,
          f.config.clerkOrganizationId,
        );
        const input = { id: randomUUID(), data };
        const denied = (error: unknown) =>
          error instanceof ApiError && error.status === 403;
        await f.db
          .updateTable('memberships')
          .set({ role: 'viewer' })
          .where('user_id', '=', userId)
          .execute();
        await assert.rejects(createCase(f.db, actor, input), denied);
        await f.db
          .updateTable('memberships')
          .set({ role: 'member' })
          .where('user_id', '=', userId)
          .execute();
        await f.db
          .updateTable('users')
          .set({ disabled: true })
          .where('id', '=', userId)
          .execute();
        await assert.rejects(createCase(f.db, actor, input), denied);
        await f.db
          .updateTable('users')
          .set({ disabled: false })
          .where('id', '=', userId)
          .execute();
        await f.db
          .updateTable('auth_sessions')
          .set({ revoked: true })
          .where('session_id', '=', actor.sessionId)
          .execute();
        await assert.rejects(createCase(f.db, actor, input), denied);
        assert.equal(
          (
            await f.db
              .selectFrom('cases')
              .select('id')
              .where('id', '=', input.id)
              .execute()
          ).length,
          0,
        );
      },
    );

    await t.test(
      'a failed provider revocation preserves the local denial and hides provider diagnostics',
      async () => {
        await f.addMember('revocation_failure', 'member');
        const revoke = f.identity.revokeSession;
        f.identity.revokeSession = async () => {
          throw new Error('Private provider diagnostics');
        };
        try {
          const response = await request(
            'DELETE',
            '/sessions/sess_revocation_failure',
            'revocation_failure',
          );
          assert.equal(response.statusCode, 500);
          assert.equal(
            response.body.includes('Private provider diagnostics'),
            false,
          );
          assert.equal(
            (await request('GET', '/me', 'revocation_failure')).statusCode,
            403,
          );
          const event = await f.db
            .selectFrom('audit_events')
            .selectAll()
            .where('resource_id', '=', 'sess_revocation_failure')
            .execute();
          assert.equal(event.length, 1);
        } finally {
          f.identity.revokeSession = revoke;
        }
      },
    );

    await t.test(
      'a restarted API reconstructs metadata and authentication observations from PostgreSQL',
      async () => {
        const restarted = await f.anotherApp();
        const response = await restarted.inject({
          url: `/api/team/cases/${caseId}`,
          headers: { authorization: 'Bearer member' },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().revision, 2);
        assert.equal(
          (
            await restarted.inject({
              url: '/api/team/me',
              headers: { authorization: 'Bearer session_owner' },
            })
          ).statusCode,
          403,
        );
      },
    );

    await t.test(
      'legacy import is repeatable and keeps unknown historical authors unknown',
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'checker-team-import-'));
        try {
          const file = join(dir, 'case.json');
          await writeFile(
            file,
            JSON.stringify({
              id: 82,
              project: 'LOCAL',
              title: 'Imported case',
              steps: [{ action: 'Open', expected_result: 'Ready' }],
            }),
          );
          const run = () =>
            spawnSync(
              process.execPath,
              [
                'src/team/server/cli.ts',
                'import-case',
                f.config.clerkOrganizationId,
                'user_owner',
                file,
              ],
              {
                encoding: 'utf8',
                env: {
                  ...process.env,
                  TEAM_DATABASE_URL: f.config.databaseUrl,
                },
              },
            );
          const first = run();
          assert.equal(first.status, 0, first.stderr);
          assert.equal(run().status, 0);
          const imported = (
            await request('GET', '/cases?search=Imported')
          ).json().items;
          assert.equal(imported.length, 1);
          assert.equal(imported[0].createdByUserId, null);
          assert.equal(imported[0].status, 'draft');
          await writeFile(
            file,
            JSON.stringify({ project: 'LOCAL', title: 'Missing ID' }),
          );
          assert.notEqual(run().status, 0);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
