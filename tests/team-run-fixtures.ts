import { randomUUID } from 'node:crypto';
import type { teamFixture } from './team-fixtures.ts';
import { resolveActor } from '../src/team/server/auth.ts';
import { publishRun } from '../src/team/server/runs.ts';
import { runDataSchema } from '../src/team/contracts.ts';

export async function seedTeamRuns(
  fixture: Awaited<ReturnType<typeof teamFixture>>,
) {
  const runs: { id: string; title: string; token: string }[] = [];
  for (const [token, count] of [
    ['member', 28],
    ['admin', 3],
  ] as const) {
    const actor = await resolveActor(
      fixture.db,
      fixture.identities.get(token)!,
      fixture.config.clerkOrganizationId,
    );
    for (let index = 1; index <= count; index++) {
      const id = randomUUID();
      const title = `e2e-agent-run-${token}-${String(index).padStart(2, '0')}`;
      const status = index % 4 === 0 ? 'running' : 'done';
      await publishRun(fixture.db, actor, {
        id,
        data: runDataSchema.parse({
          title,
          project: 'LOCAL',
          caseLabel: `LOCAL-${index}`,
          status,
          outcome:
            status === 'running' ? null : index % 3 === 0 ? 'fail' : 'pass',
          provider: token === 'member' ? 'codex' : 'claude-code',
          model: token === 'member' ? 'gpt-6.1-sol' : 'claude-haiku',
          environmentName: 'Local review',
          summary:
            'Disposable review run. Checks and results stay attached to the initiating team member.',
          startedAt: new Date(Date.now() - 90000).toISOString(),
          finishedAt: status === 'done' ? new Date().toISOString() : null,
        }),
      });
      runs.push({ id, title, token });
    }
  }
  return runs;
}
