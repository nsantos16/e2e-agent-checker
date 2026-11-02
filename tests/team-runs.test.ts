import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { teamFixture } from './team-fixtures.ts';
import { runDataSchema, runPageSchema } from '../src/team/contracts.ts';
import { resolveActor } from '../src/team/server/auth.ts';
import { publishRun } from '../src/team/server/runs.ts';
import { migrate } from '../src/team/server/migrate.ts';

test(
  'shared runs persist trusted ownership, filter across pages and isolate organizations',
  { skip: !process.env.TEAM_TEST_DATABASE_URL },
  async (t) => {
    const f = await teamFixture();
    t.after(() => f.close());
    await f.initialize();
    const request = (
      method: 'GET' | 'POST' | 'PATCH',
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
    const data = runDataSchema.parse({
      title: 'e2e-agent-run',
      status: 'queued',
    });
    const ids = Array.from({ length: 6 }, () => randomUUID());
    for (let i = 0; i < ids.length; i++) {
      const response = await request(
        'POST',
        '/runs',
        i % 2 ? 'admin' : 'member',
        { id: ids[i], data },
      );
      assert.equal(response.statusCode, 201);
      assert.equal(
        response.json().initiatedBy.id,
        f.users.get(i % 2 ? 'admin' : 'member'),
      );
    }

    await t.test(
      'authentication and strict inputs prevent forged ownership and viewer publication',
      async () => {
        assert.equal((await f.app.inject('/api/team/runs')).statusCode, 401);
        assert.equal(
          (await request('POST', '/runs', 'viewer', { id: randomUUID(), data }))
            .statusCode,
          403,
        );
        for (const forged of [
          { initiatedBy: { id: f.users.get('admin'), name: 'admin' } },
          { orgId: randomUUID() },
        ])
          assert.equal(
            (
              await request('POST', '/runs', 'member', {
                id: randomUUID(),
                data,
                ...forged,
              })
            ).statusCode,
            400,
          );
        assert.equal(
          (await request('GET', '/runs?userId=not-a-user')).statusCode,
          400,
        );
        assert.equal(
          (await request('GET', '/runs?after=invalid')).statusCode,
          400,
        );
        assert.equal(
          (
            await request('POST', '/runs', 'member', {
              id: randomUUID(),
              data: { ...data, outcome: 'pass' },
            })
          ).statusCode,
          400,
        );
      },
    );
    await t.test(
      'only the initiating member can update status; revisions and retry identity are retained',
      async () => {
        assert.equal(
          (
            await request('POST', '/runs', 'member', { id: ids[0], data })
          ).json().revision,
          1,
        );
        assert.equal(
          (
            await request('POST', '/runs', 'member', {
              id: ids[0],
              data: { ...data, title: 'different' },
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await request('PATCH', `/runs/${ids[0]}`, 'admin', {
              expectedRevision: 1,
              data,
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request('PATCH', `/runs/${ids[0]}`, 'member', {
              expectedRevision: 1,
              data,
              initiatedBy: f.users.get('admin'),
            })
          ).statusCode,
          400,
        );
        const updated = await request('PATCH', `/runs/${ids[0]}`, 'member', {
          expectedRevision: 1,
          data: { ...data, status: 'done', outcome: 'pass' },
        });
        assert.equal(updated.statusCode, 200);
        assert.equal(updated.json().revision, 2);
        assert.equal(updated.json().initiatedBy.id, f.users.get('member'));
        assert.equal(
          (
            await request('PATCH', `/runs/${ids[0]}`, 'member', {
              expectedRevision: 1,
              data,
            })
          ).statusCode,
          409,
        );
      },
    );
    await t.test(
      'filtering and totals cover all matches, with deterministic paging for tied timestamps',
      async () => {
        await f.db
          .updateTable('runs')
          .set({ created_at: new Date('2026-11-01T00:00:00.000Z') })
          .execute();
        const all = (await request('GET', '/runs?limit=2', 'viewer')).json();
        assert.equal(all.stats.total, 6);
        assert.equal(all.stats.active, 5);
        assert.equal(all.stats.passed, 1);
        assert.equal(all.items.length, 2);
        assert.ok(
          all.users.some(
            (user: { id: string }) => user.id === f.users.get('viewer'),
          ),
        );
        assert.deepEqual(Object.keys(all.users[0]).sort(), ['id', 'name']);
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const result: ReturnType<typeof runPageSchema.parse> =
            runPageSchema.parse(
              (
                await request(
                  'GET',
                  `/runs?limit=2&userId=${f.users.get('member')}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`,
                  'viewer',
                )
              ).json(),
            );
          assert.equal(result.stats.total, 3);
          assert.equal(result.stats.passed, 1);
          for (const run of result.items) {
            assert.equal(run.initiatedBy.id, f.users.get('member'));
            seen.push(run.id);
          }
          cursor = result.nextCursor;
        } while (cursor);
        assert.deepEqual(seen, [ids[0], ids[2], ids[4]].sort().reverse());
        assert.equal(
          (await request('GET', `/runs?userId=${f.users.get('viewer')}`)).json()
            .stats.total,
          0,
        );
      },
    );
    await t.test(
      'foreign teams cannot leak through detail, filters or the user directory',
      async () => {
        const foreignOrg = randomUUID();
        await f.db
          .insertInto('organizations')
          .values({
            id: foreignOrg,
            clerk_org_id: 'org_other_runs',
            name: 'Other team',
          })
          .execute();
        const outsider = await f.addMember(
          'run-outsider',
          'member',
          foreignOrg,
          'org_other_runs',
        );
        const actor = await resolveActor(
          f.db,
          f.identities.get('run-outsider')!,
          'org_other_runs',
        );
        const foreign = await publishRun(f.db, actor, {
          id: randomUUID(),
          data: { ...data, title: 'Private foreign run' },
        });
        assert.equal(
          (await request('GET', `/runs/${foreign.id}`)).statusCode,
          404,
        );
        const filtered = (
          await request('GET', `/runs?userId=${outsider}`)
        ).json();
        assert.deepEqual(filtered.items, []);
        assert.equal(filtered.stats.total, 0);
        assert.ok(
          filtered.users.every((user: { id: string }) => user.id !== outsider),
        );
        assert.equal(
          (await request('GET', '/runs', 'run-outsider')).statusCode,
          403,
        );
      },
    );
    await t.test(
      'restart, repeat migrations and disabled creators retain historical attribution',
      async () => {
        await migrate(f.pool);
        await f.db
          .updateTable('memberships')
          .set({ disabled: true })
          .where('org_id', '=', f.orgId)
          .where('user_id', '=', f.users.get('admin')!)
          .execute();
        const restarted = await f.anotherApp();
        const response = await restarted.inject({
          url: `/api/team/runs/${ids[1]}`,
          headers: { authorization: 'Bearer viewer' },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().initiatedBy.id, f.users.get('admin'));
        assert.equal(
          (await request('GET', `/runs?userId=${f.users.get('admin')}`)).json()
            .stats.total,
          3,
        );
        assert.equal((await request('GET', '/runs', 'admin')).statusCode, 403);
      },
    );
  },
);
