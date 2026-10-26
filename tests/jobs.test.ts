import { Deferred, Effect } from 'effect';
import { runEffect } from '../src/runtime/effect.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(predicate(), 'condition did not complete');
};
test('jobs preserve recovery, idempotency, identity serialization, cancellation and execution-time reuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-jobs-'));
  const names = ['PATH', 'E2E_JOBS_PATH', 'E2E_CASES_PATH', 'E2E_ENVIRONMENTS_PATH', 'E2E_RUNS_DIR'] as const;
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.E2E_JOBS_PATH = join(dir, 'jobs.json');
  process.env.E2E_CASES_PATH = join(dir, 'cases.json');
  process.env.E2E_ENVIRONMENTS_PATH = join(dir, 'environments.json');
  process.env.E2E_RUNS_DIR = join(dir, 'runs');
  process.env.PATH = dir + ':' + old.PATH;
  writeFileSync(
    join(dir, 'jobs.json'),
    JSON.stringify([
      { id: 'interrupted', status: 'running', createdAt: '', project: 'LOCAL', caseId: 1, worktree: '', role: 'qa', log: [] },
    ]),
  );
  const eventsPath = join(dir, 'events.jsonl');
  const holdPath = join(dir, 'hold');
  // Controlled native commands exercise the real queue, provider adapter and file
  // contracts. No credentials, browser or paid model service is used by this test.
  const common = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const event=e=>fs.appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify(e)+'\\n');
const json=(p,v)=>fs.writeFileSync(p,JSON.stringify(v));\n`;
  writeFileSync(
    join(dir, 'claude'),
    '#!/usr/bin/env node\n' +
      common +
      `
if(process.argv.includes('auth')) {event({kind:'preflight'}); console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));}
else {
  const c=JSON.parse(fs.readFileSync('stage-config.json','utf8'));
  event({kind:'model',stage:c.specPath?'codify':'explore',run:c.runDir});
  let result;
  if(c.specPath){
    const source="import {test} from '@playwright/test'; test('fixture',async()=>{});";
    fs.writeFileSync(c.specPath,source);
    json(path.join(c.runDir,'codify/attempts.json'),{attempts:1});
    json(path.join(c.runDir,'codify/last-attempt.json'),{specHash:crypto.createHash('sha256').update(source).digest('hex'),code:0,result:{status:'passed'}});
    result={specPath:c.specPath,attempts:1,outcome:'passed',failingStep:null};
  }else result={caseId:1,verdict:'pass',steps:[{position:1,verdict:'pass',evidence:'Historical fixture'}]};
  setTimeout(()=>console.log(JSON.stringify({type:'result',result:JSON.stringify(result),usage:{input_tokens:10,output_tokens:2},num_turns:1})),60);
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, 'npx'),
    '#!/usr/bin/env node\n' +
      common +
      `
const out=process.env.E2E_OUTPUT_DIR;
event({kind:'replay-start',run:process.env.E2E_OBSERVATION_RUN_DIR,base:process.env.E2E_BASE_URL,state:process.env.E2E_STORAGE_STATE});
const finish=()=>{
  if(fs.existsSync(${JSON.stringify(holdPath)})) return setTimeout(finish,20);
  json(path.join(out,'results.json'),{suites:[{specs:[{tests:[{results:[{status:'passed',duration:1,steps:[{title:'Step 1: Fixture'}]}]}]}]}]});
  event({kind:'replay-end',run:process.env.E2E_OBSERVATION_RUN_DIR});
};setTimeout(finish,150);
`,
    { mode: 0o755 },
  );
  const { CheckerLive } = await import('../src/runtime/services.ts');
  const { CaseRepository } = await import('../src/runtime/repositories.ts');
  const { submitBatch, cancelJob, replayJob, listJobs, getJob, shutdownJobs, submitBatchEffect } = await import('../src/jobs.ts');
  const { caseCatalog } = await import('../src/cases.ts');
  const { saveEnvironment, environmentSessionPath } = await import('../src/environments.ts');
  const { specLocation } = await import('../src/codify.ts');
  const sessions: string[] = [];
  const events = () =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((s) => JSON.parse(s))
      : [];
  try {
    assert.equal(getJob('interrupted')?.status, 'interrupted');
    assert.ok(JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8'))[0].finishedAt);
    const testCase = caseCatalog.create({
      title: 'Queue fixture',
      status: 'active',
      steps: [{ action: 'Open', expected_result: 'Ready' }],
    });
    const user = { id: 'qa', name: 'QA', usernameRef: 'env://NONEXISTENT_USER', passwordRef: 'env://NONEXISTENT_PASSWORD' };
    const environment = saveEnvironment({
      environment: { id: 'fixture', name: 'Fixture', kind: 'hosted', baseUrl: 'https://fixture.test', users: [user] },
    });
    const session = environmentSessionPath(environment, user, environment.baseUrl!);
    sessions.push(session);
    mkdirSync(join(session, '..'), { recursive: true });
    writeFileSync(session, JSON.stringify({ cookies: [], origins: [] }));
    const input = {
      cases: [{ project: testCase.project, id: testCase.id }],
      environmentId: environment.id,
      userId: user.id,
      targets: [{ provider: 'claude-code', model: 'sonnet' }],
      idempotencyKey: 'same-batch',
    };
    await assert.rejects(submitBatch({ ...input, targets: [{ provider: 'invalid', model: 'sonnet' }] }), /Invalid option/);
    assert.equal(listJobs().length, 1, 'structural batch validation is atomic');
    assert.equal(events().length, 0, 'submissions do not preflight providers');
    const [first, duplicate, second] = await Promise.all([
      submitBatch(input),
      submitBatch(input),
      submitBatch({ ...input, idempotencyKey: 'second', buildId: 'new-build' }),
    ]);
    assert.equal(first[0].id, duplicate[0].id);
    assert.notEqual(first[0].id, second[0].id);
    assert.equal(second[0].status, 'queued', 'same test identity serializes');
    assert.throws(() => replayJob('interrupted'), /no saved run/);
    await assert.rejects(submitBatch({ ...input, forceFresh: true }), /different inputs/);
    await until(() => first[0].status === 'done' && second[0].status === 'done');
    assert.equal(first[0].specSelection?.mode, 'author');
    assert.equal(second[0].specSelection?.mode, 'reuse', 'selection runs after the previous job publishes its spec');
    assert.equal(second[0].testedBuild?.buildId, 'new-build');
    assert.equal(second[0].usage?.totalTokens, 0);
    assert.equal(second[0].exploreVerdict, undefined);
    assert.ok(second[0].historicalExploration);
    assert.equal(events().filter((e) => e.kind === 'model').length, 2);
    assert.equal(events().filter((e) => e.kind === 'preflight').length, 2, 'only the original two authoring stages preflight');
    assert.deepEqual(
      events()
        .filter((e) => e.kind.startsWith('replay'))
        .map((e) => e.kind),
      ['replay-start', 'replay-end', 'replay-start', 'replay-end'],
    );
    assert.ok(
      events()
        .filter((e) => e.kind === 'replay-start')
        .every((e) => e.base === environment.baseUrl && e.state === session),
    );
    assert.notEqual(first[0].runDir, second[0].runDir);
    assert.notEqual(first[0].replay.results, second[0].replay.results);
    const replay = replayJob(second[0].id);
    await until(() => replay.status === 'done');
    assert.equal(replay.specSelection?.mode, 'replay');
    assert.equal(replay.usage?.totalTokens, 0);
    writeFileSync(holdPath, '');
    const reading = (await submitBatch({ ...input, idempotencyKey: 'reading' }))[0];
    await until(() => reading.stage === 'replay');
    const missing = (await submitBatch({ ...input, idempotencyKey: 'missing-after-submit' }))[0];
    assert.equal(missing.status, 'queued');
    rmSync(join(first[0].runDir!, 'codify/LOCAL-1.spec.ts'));
    rmSync(holdPath);
    await until(() => reading.status === 'done' && missing.status === 'done');
    assert.equal(reading.specSelection?.mode, 'reuse', 'validated spec bytes survive deletion of the source');
    assert.equal(missing.specSelection?.mode, 'author');
    assert.equal(missing.specSelection?.reason, 'artifact-missing', 'queued submissions validate artifacts when executed');
    assert.equal(events().filter((e) => e.kind === 'model').length, 4);
    // Hold execution while checking cancellation and immutable queued snapshots.
    writeFileSync(holdPath, '');
    const held = (await submitBatch({ ...input, idempotencyKey: 'held' }))[0];
    await until(() => held.stage === 'replay');
    const queued = (await submitBatch({ ...input, idempotencyKey: 'queued' }))[0];
    assert.equal(queued.status, 'queued');
    saveEnvironment({
      environment: {
        id: 'alias',
        name: 'Same account alias',
        kind: 'hosted',
        baseUrl: 'https://alias.test',
        users: [{ ...user, id: 'alias-user' }],
      },
    });
    const alias = (await submitBatch({ ...input, environmentId: 'alias', userId: 'alias-user', idempotencyKey: 'alias' }))[0];
    assert.equal(alias.status, 'queued', 'credential aliases retain identity serialization across environments');
    cancelJob(alias.id);
    caseCatalog.update('LOCAL', 1, { expectedRevision: testCase.revision, changes: { title: 'Edited after queueing' } });
    assert.equal(queued.caseSnapshot?.title, 'Queue fixture');
    assert.equal(cancelJob(queued.id).status, 'cancelled');
    assert.equal(cancelJob(queued.id).status, 'cancelled');
    cancelJob(held.id);
    await until(() => held.status === 'cancelled');
    assert.equal(held.usage?.totalTokens, 0);
    assert.ok(held.timing?.activeMs);
    const native = caseCatalog.create({ title: 'Draft' });
    await assert.rejects(submitBatch({ ...input, idempotencyKey: 'draft', cases: [{ project: 'LOCAL', id: native.id }] }), {
      code: 'CASE_NOT_ACTIVE',
    });
    // Block a submission in case lookup to exercise shutdown before atomic acceptance.
    const stoppingBatch = await submitBatch({ ...input, idempotencyKey: 'shutdown', targets: [...input.targets, ...input.targets] });
    const entered = Deferred.makeUnsafe<void>(),
      release = Deferred.makeUnsafe<void>();
    const repository = await runEffect(CaseRepository.pipe(Effect.provide(CheckerLive)));
    const inFlight = runEffect(
      submitBatchEffect({ ...input, idempotencyKey: 'during-shutdown' }).pipe(
        Effect.provideService(CaseRepository, {
          ...repository,
          get: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return testCase;
            }),
        }),
        Effect.provide(CheckerLive),
      ),
    );
    const rejected = assert.rejects(inFlight, { code: 'APP_UNAVAILABLE' });
    await runEffect(Deferred.await(entered));
    await shutdownJobs();
    await runEffect(Deferred.succeed(release, undefined));
    await rejected;
    assert.equal(
      listJobs().some((j) => j.idempotencyKey === 'during-shutdown'),
      false,
    );
    assert.ok(stoppingBatch.every((j) => j.status === 'interrupted' && j.finishedAt));
    assert.equal(
      listJobs().some((j) => ['running', 'queued', 'cancelling'].includes(j.status)),
      false,
    );
    await assert.rejects(submitBatch({ ...input, idempotencyKey: 'after-shutdown' }), { code: 'APP_UNAVAILABLE' });
  } finally {
    await shutdownJobs();
    for (const job of listJobs())
      if (job.runDir) rmSync(specLocation(job.runDir, job.project, job.caseId).specDir, { recursive: true, force: true });
    for (const session of sessions) rmSync(session, { force: true });
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
