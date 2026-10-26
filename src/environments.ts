import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const environmentId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const secretRef = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => /^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(v) || /^op:\/\/[^/\r\n]+\/[^/\r\n]+\/[^\r\n]+$/.test(v),
    'Use op://vault/item/field or env://VARIABLE_NAME',
  );
export const testUserSchema = z
  .object({
    id: environmentId,
    name: z.string().trim().min(1).max(100),
    usernameRef: secretRef,
    passwordRef: secretRef,
    totpRef: secretRef.optional(),
  })
  .strict();
const baseUrlSchema = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
  }, 'Use an HTTP(S) origin without credentials, a path, query or fragment')
  .transform((v) => new URL(v).origin);
export const environmentSchema = z
  .object({
    id: environmentId,
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['worktree', 'hosted']),
    baseUrl: baseUrlSchema.optional(),
    devMode: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
      .default('ci.development'),
    users: z.array(testUserSchema).min(1).max(30),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.kind === 'hosted' && !e.baseUrl)
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Hosted environments require a base URL' });
    if (e.kind === 'worktree' && e.baseUrl)
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Worktree URLs are assigned by the local dev server' });
    if (new Set(e.users.map((u) => u.id)).size !== e.users.length)
      ctx.addIssue({ code: 'custom', path: ['users'], message: 'User IDs must be unique within the environment' });
  });
export const saveEnvironmentSchema = z.object({ environment: environmentSchema, expectedRevision: z.string().optional() }).strict();
export type TestUser = z.infer<typeof testUserSchema>;
export type Environment = z.infer<typeof environmentSchema> & { revision: string };
const root = new URL('..', import.meta.url).pathname;
const path = () => process.env.E2E_ENVIRONMENTS_PATH ?? join(root, '.state/environments.json');
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
function defaults(): Environment[] {
  const { roles } = JSON.parse(readFileSync(join(root, 'config/roles.json'), 'utf8'));
  return [
    {
      id: 'local',
      name: 'Local development',
      kind: 'worktree',
      devMode: 'ci.development',
      revision: 'legacy-local-v1',
      users: Object.entries(roles).map(([id, r]: [string, any]) => ({
        id,
        name: id,
        usernameRef: r.username,
        passwordRef: r.password,
        ...(r.totp ? { totpRef: r.totp } : {}),
      })),
    },
  ];
}
// Retain observed names so edits cannot re-expose credentials to a later child process.
const credentialVariables = new Set<string>(['OP_SERVICE_ACCOUNT_TOKEN']);
export const listEnvironments = (): Environment[] => {
  const environments: Environment[] = existsSync(path()) ? JSON.parse(readFileSync(path(), 'utf8')) : defaults();
  for (const environment of environments)
    for (const user of environment.users)
      for (const ref of [user.usernameRef, user.passwordRef, user.totpRef])
        if (ref?.startsWith('env://')) credentialVariables.add(ref.slice(6));
  return environments;
};
export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  listEnvironments();
  const env = { ...source };
  for (const name of credentialVariables) delete env[name];
  return env;
}
export const getEnvironment = (id = 'local') =>
  listEnvironments().find((e) => e.id === id) ?? fail('ENVIRONMENT_NOT_FOUND', 'Choose a configured environment');
export const getTestUser = (e: Environment, id?: string) =>
  e.users.find((u) => u.id === (id ?? e.users[0]?.id)) ?? fail('TEST_USER_NOT_FOUND', 'Choose a user configured for this environment');
export const environmentSummary = (e: Environment) => ({
  id: e.id,
  name: e.name,
  kind: e.kind,
  baseUrl: e.baseUrl,
  devMode: e.kind === 'worktree' ? e.devMode : undefined,
  revision: e.revision,
  users: e.users.map((u) => ({
    id: u.id,
    name: u.name,
    credentials: [u.usernameRef, u.passwordRef].map((r) => (r.startsWith('op://') ? '1password' : 'environment')),
    hasTotp: !!u.totpRef,
  })),
});
function persist(environments: Environment[]) {
  mkdirSync(dirname(path()), { recursive: true });
  const temp = path() + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(environments, null, 2), { mode: 0o600 });
  renameSync(temp, path());
}
export function saveEnvironment(input: unknown) {
  const { environment, expectedRevision } = saveEnvironmentSchema.parse(input);
  const all = listEnvironments(),
    old = all.find((e) => e.id === environment.id);
  if (old ? old.revision !== expectedRevision : !!expectedRevision)
    fail('REVISION_CONFLICT', 'Environment changed. Reload settings before saving.');
  const saved = { ...environment, revision: randomUUID() };
  persist([...all.filter((e) => e.id !== saved.id), saved]);
  return saved;
}
export function deleteEnvironment(id: string, expectedRevision: string) {
  const e = getEnvironment(id);
  if (e.id === 'local') fail('ENVIRONMENT_REQUIRED', 'The default local environment cannot be deleted');
  if (e.revision !== expectedRevision) fail('REVISION_CONFLICT', 'Environment changed. Reload settings before deleting.');
  persist(listEnvironments().filter((e) => e.id !== id));
}
// Revision and origin prevent sessions surviving target/credential-reference edits.
export const environmentSessionPath = (e: Environment, user: TestUser, base: string) =>
  join(
    root,
    '.state/sessions',
    createHash('sha256')
      .update(JSON.stringify([e.id, e.revision, user.id, new URL(base).origin]))
      .digest('hex') + '.json',
  );
// Credential-reference identity also serializes aliases shared by multiple profiles.
export const testIdentityKey = (user: TestUser) => createHash('sha256').update(user.usernameRef).digest('hex');

// Worktree ports/builds may change. Profile revisions and credential-reference
// changes must still invalidate reuse; never include credential values.
export const environmentRequirements = (e: Environment, user: TestUser, base: string) => ({
  id: e.id,
  revision: e.revision,
  kind: e.kind,
  devMode: e.devMode,
  origin: e.kind === 'hosted' ? new URL(base).origin : undefined,
  userId: user.id,
  credentialReferencesSha256: createHash('sha256')
    .update(JSON.stringify([user.usernameRef, user.passwordRef, user.totpRef ?? null]))
    .digest('hex'),
});
