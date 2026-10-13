import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveEnvironment,
  listEnvironments,
  getEnvironment,
  getTestUser,
  deleteEnvironment,
  environmentSummary,
  environmentSessionPath,
  testIdentityKey,
  environmentSchema,
} from '../src/environments.ts';
import { command } from '../src/process.ts';
import { resolveTestUser } from '../src/credentials.ts';
const user = { id: 'admin', name: 'QA admin', usernameRef: 'env://CHECKER_TEST_USERNAME', passwordRef: 'env://CHECKER_TEST_PASSWORD' };

test('environment CRUD accepts references only, rejects stale edits and isolates sessions by target, user and revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-environments-'));
  const oldPath = process.env.E2E_ENVIRONMENTS_PATH;
  process.env.E2E_ENVIRONMENTS_PATH = join(dir, 'environments.json');
  try {
    assert.equal(listEnvironments()[0].id, 'local');
    assert.doesNotThrow(
      () => environmentSchema.parse(listEnvironments().map(({ revision, ...e }) => e)[0]),
      'legacy 1Password fields with spaces remain valid',
    );
    const staging = saveEnvironment({
      environment: { id: 'staging', name: 'Staging', kind: 'hosted', baseUrl: 'https://staging.example.test/', users: [user] },
    });
    const child = await command(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify({username:process.env.CHECKER_TEST_USERNAME,password:process.env.CHECKER_TEST_PASSWORD,op:process.env.OP_SERVICE_ACCOUNT_TOKEN,keep:process.env.CHECKER_TEST_KEEP}))',
      ],
      {
        env: {
          ...process.env,
          CHECKER_TEST_USERNAME: 'dummy-user',
          CHECKER_TEST_PASSWORD: 'dummy-password',
          OP_SERVICE_ACCOUNT_TOKEN: 'dummy-token',
          CHECKER_TEST_KEEP: 'retained',
        },
      },
    );
    assert.equal(child.code, 0);
    assert.deepEqual(JSON.parse(child.stdout), { keep: 'retained' });
    assert.equal(staging.baseUrl, 'https://staging.example.test');
    assert.equal(getEnvironment('staging').revision, staging.revision);
    assert.equal(getTestUser(staging, 'admin').id, 'admin');
    assert.throws(() => getTestUser(staging, 'missing'), { code: 'TEST_USER_NOT_FOUND' });
    assert.throws(() => saveEnvironment({ environment: { ...staging, revision: undefined } }), /Unrecognized/);
    const { revision, ...definition } = staging;
    assert.throws(() => saveEnvironment({ environment: definition }), { code: 'REVISION_CONFLICT' });
    assert.throws(() =>
      saveEnvironment({ environment: { ...definition, id: 'bad', users: [{ ...user, passwordRef: 'actual-password' }] } }),
    );
    for (const baseUrl of [
      'https://name:secret@example.test',
      'file:///etc/passwd',
      'https://example.test/path',
      'https://example.test?token=x',
    ])
      assert.throws(() => saveEnvironment({ environment: { ...definition, id: 'bad', baseUrl } }));
    assert.throws(() => saveEnvironment({ environment: { ...definition, id: 'duplicate', users: [user, user] } }));
    const path = environmentSessionPath(staging, user, staging.baseUrl!);
    const other = saveEnvironment({ environment: { ...definition, id: 'other' } });
    assert.notEqual(path, environmentSessionPath(other, user, other.baseUrl!));
    assert.notEqual(path, environmentSessionPath(staging, { ...user, id: 'viewer' }, staging.baseUrl!));
    assert.notEqual(path, environmentSessionPath(staging, user, 'https://another.example.test'));
    const changed = saveEnvironment({ environment: { ...definition, name: 'Staging changed' }, expectedRevision: revision });
    assert.notEqual(path, environmentSessionPath(changed, user, changed.baseUrl!));
    assert.equal(testIdentityKey(user), testIdentityKey({ ...user, id: 'alias' }), 'shared account references share a queue lock');
    const summary = environmentSummary(changed);
    assert.equal('passwordRef' in summary.users[0], false);
    assert.equal('usernameRef' in summary.users[0], false);
    assert.throws(() => deleteEnvironment('staging', revision), { code: 'REVISION_CONFLICT' });
    deleteEnvironment('staging', changed.revision);
    assert.throws(() => getEnvironment('staging'), { code: 'ENVIRONMENT_NOT_FOUND' });
    assert.throws(() => deleteEnvironment('local', 'legacy-local-v1'), { code: 'ENVIRONMENT_REQUIRED' });
    assert.match(readFileSync(process.env.E2E_ENVIRONMENTS_PATH, 'utf8'), /env:\/\/CHECKER_TEST_PASSWORD/);
  } finally {
    if (oldPath === undefined) delete process.env.E2E_ENVIRONMENTS_PATH;
    else process.env.E2E_ENVIRONMENTS_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credential environment references resolve in the harness and missing values fail without revealing other secrets', async () => {
  const oldUsername = process.env.CHECKER_TEST_USERNAME,
    oldPassword = process.env.CHECKER_TEST_PASSWORD;
  process.env.CHECKER_TEST_USERNAME = 'test-user';
  process.env.CHECKER_TEST_PASSWORD = 'test-only-secret';
  try {
    assert.deepEqual(await resolveTestUser(user), { username: 'test-user', password: 'test-only-secret' });
    delete process.env.CHECKER_TEST_PASSWORD;
    await assert.rejects(
      resolveTestUser(user),
      (error: any) => error.code === 'CREDENTIAL_UNAVAILABLE' && !error.message.includes('test-only-secret'),
    );
  } finally {
    if (oldUsername === undefined) delete process.env.CHECKER_TEST_USERNAME;
    else process.env.CHECKER_TEST_USERNAME = oldUsername;
    if (oldPassword === undefined) delete process.env.CHECKER_TEST_PASSWORD;
    else process.env.CHECKER_TEST_PASSWORD = oldPassword;
  }
});
