// Real harness login against two disposable localhost environments. No model or vault calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { loginSlot } from '../src/login.ts';
import { environmentSessionPath, type Environment } from '../src/environments.ts';

const html = `<!doctype html><form><input placeholder="Email" id="email"><input placeholder="Password" type="password"><button>Login</button></form><script>
document.querySelector('form').onsubmit = (e) => { e.preventDefault(); const email = document.querySelector('#email').value;
const req = indexedDB.open('localforage',1); req.onupgradeneeded=()=>req.result.createObjectStore('keyvaluepairs');
req.onsuccess=()=>{const tx=req.result.transaction('keyvaluepairs','readwrite');tx.objectStore('keyvaluepairs').put({userResults:JSON.stringify({email,hasSeen2FAModal:false})},'persist:root');tx.oncomplete=()=>{document.cookie='fixtureUser='+email+'; path=/';location.href='/home';};};};
</script>`;
const servers = [0, 1].map(() =>
  createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/login' ? html : '<h1>Signed in</h1>');
  }),
);
const paths: string[] = [];
const oldUser = process.env.CHECKER_SMOKE_USERNAME,
  oldPassword = process.env.CHECKER_SMOKE_PASSWORD;
try {
  const results = [];
  for (const [index, server] of servers.entries()) {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const user = { id: 'tester', name: 'Tester', usernameRef: 'env://CHECKER_SMOKE_USERNAME', passwordRef: 'env://CHECKER_SMOKE_PASSWORD' };
    const environment: Environment = {
      id: `smoke-${index}`,
      name: `Fixture ${index}`,
      kind: 'hosted',
      baseUrl: base,
      revision: 'smoke',
      devMode: 'ci.development',
      users: [user],
    };
    process.env.CHECKER_SMOKE_USERNAME = `fixture-user-${index}`;
    process.env.CHECKER_SMOKE_PASSWORD = 'fixture-only-password';
    const storageState = environmentSessionPath(environment, user, base);
    paths.push(storageState);
    await loginSlot({ base, role: user.id, slot: environment.id, user, storageState });
    const state = JSON.parse(readFileSync(storageState, 'utf8'));
    assert.equal(state.cookies.find((c: any) => c.name === 'fixtureUser').value, `fixture-user-${index}`);
    assert.ok(state.origins.some((o: any) => o.origin === base));
    assert.equal(statSync(storageState).mode & 0o777, 0o600);
    results.push({ environment: environment.id, login: 'passed', sessionMode: '0600' });
  }
  assert.notEqual(paths[0], paths[1]);
  assert.equal(JSON.parse(readFileSync(paths[0], 'utf8')).cookies.find((c: any) => c.name === 'fixtureUser').value, 'fixture-user-0');
  console.log(JSON.stringify({ passed: 2, isolated: true, results }));
} finally {
  for (const path of paths) if (existsSync(path)) rmSync(path);
  await Promise.all(servers.map((server) => new Promise<void>((r) => server.close(() => r()))));
  if (oldUser === undefined) delete process.env.CHECKER_SMOKE_USERNAME;
  else process.env.CHECKER_SMOKE_USERNAME = oldUser;
  if (oldPassword === undefined) delete process.env.CHECKER_SMOKE_PASSWORD;
  else process.env.CHECKER_SMOKE_PASSWORD = oldPassword;
}
