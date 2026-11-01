import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  defaultInstanceId,
  instanceConfigSchema,
  providerId,
  saveInstanceSchema,
  type ProviderInstance,
  type ProviderKind,
} from './schema.ts';
import { RunError } from './errors.ts';

export const providerNames = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
export const binaries = { 'claude-code': 'claude', codex: 'codex', cursor: 'agent' };
export const profiles = { 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', cursor: '' };
const root = new URL('../..', import.meta.url).pathname;
export const instancesPath = () => process.env.E2E_PROVIDERS_PATH ?? join(root, '.state/providers.json');
const stateSchema = z.object({
  version: z.literal(1),
  selectedInstanceId: z.string().optional(),
  instances: z.array(instanceConfigSchema.extend({ revision: z.string() })),
});
const defaults = (): ProviderInstance[] =>
  providerId.options.map((provider) => ({
    id: defaultInstanceId(provider),
    provider,
    name: providerNames[provider],
    binaryPath: binaries[provider],
    enabled: true,
    options: {},
    revision: 'default-v1',
  }));
export const readInstances = () =>
  existsSync(instancesPath())
    ? stateSchema.parse(JSON.parse(readFileSync(instancesPath(), 'utf8')))
    : { version: 1 as const, selectedInstanceId: undefined, instances: defaults() };
export function getInstance(id: string) {
  const i = readInstances().instances.find((i) => i.id === id);
  if (!i) throw new RunError('INSTANCE_NOT_FOUND', 'This provider instance no longer exists. Select an account in Settings.');
  return i;
}
export const expandPath = (path: string) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
export function profilePath(i: ProviderInstance) {
  if (i.provider === 'cursor') return undefined;
  return resolve(
    expandPath(i.configDir ?? process.env[profiles[i.provider]] ?? join(homedir(), i.provider === 'codex' ? '.codex' : '.claude')),
  );
}
// Canonicalize existing ancestors too, so an uncreated child of a symlink cannot alias another account.
const canonical = (path: string): string =>
  existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), path.slice(dirname(path).length + 1));
function persist(state: ReturnType<typeof readInstances>) {
  mkdirSync(dirname(instancesPath()), { recursive: true });
  const tmp = `${instancesPath()}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, instancesPath());
}
export function saveInstance(input: unknown) {
  const { instance, expectedRevision } = saveInstanceSchema.parse(input);
  const state = readInstances(),
    old = state.instances.find((i) => i.id === instance.id);
  if (old ? old.revision !== expectedRevision : expectedRevision !== undefined)
    throw new RunError('REVISION_CONFLICT', 'Instance changed. Reload Settings before saving.');
  if (old && old.provider !== instance.provider)
    throw new RunError('INVALID_INPUT', 'An instance cannot change provider kind. Create a new instance.');
  if (instance.configDir && !isAbsolute(expandPath(instance.configDir)))
    throw new RunError('INVALID_INPUT', 'Configuration directory must be an absolute path or start with ~/.');
  if (instance.binaryPath.includes('/') && !isAbsolute(expandPath(instance.binaryPath)))
    throw new RunError('INVALID_INPUT', 'Binary must be a command name or an absolute path.');
  if (instance.provider === 'cursor' && (instance.configDir || instance.options.effort))
    throw new RunError('CAPABILITY_UNSUPPORTED', 'Separate Cursor profiles and launch options are not verified.');
  const saved = { ...instance, revision: randomUUID() };
  const path = profilePath(saved);
  if (
    path &&
    state.instances.some((i) => i.id !== saved.id && i.provider === saved.provider && canonical(profilePath(i)!) === canonical(path))
  )
    throw new RunError('PROFILE_CONFLICT', 'Another instance uses this native profile. Use a separate directory and sign in there.');
  persist({ ...state, instances: [...state.instances.filter((i) => i.id !== saved.id), saved] });
  return saved;
}
export function selectInstance(id: string, expectedRevision: string) {
  const instance = getInstance(id);
  if (instance.revision !== expectedRevision) throw new RunError('REVISION_CONFLICT', 'Instance changed. Refresh before selecting.');
  if (!instance.enabled) throw new RunError('INSTANCE_DISABLED', 'Enable this instance before selecting it.');
  persist({ ...readInstances(), selectedInstanceId: id });
  return instance;
}
export function deleteInstance(id: string, expectedRevision: string) {
  const instance = getInstance(id);
  if (instance.revision !== expectedRevision) throw new RunError('REVISION_CONFLICT', 'Instance changed. Reload Settings before deleting.');
  if (id === defaultInstanceId(instance.provider))
    throw new RunError('INSTANCE_REQUIRED', 'Disable the default instance instead; legacy targets resolve to it.');
  const state = readInstances();
  persist({
    ...state,
    selectedInstanceId: state.selectedInstanceId === id ? undefined : state.selectedInstanceId,
    instances: state.instances.filter((i) => i.id !== id),
  });
  return { id, deleted: true };
}

const commonOverrides = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SIMPLE',
  'CURSOR_API_KEY',
];
export const ignoredEnvironment = () => commonOverrides.filter((key) => !!process.env[key]);
export function instanceEnvironment(i: ProviderInstance) {
  const env = { ...process.env };
  for (const key of commonOverrides) delete env[key];
  // Ambient aliases can silently redirect a requested Claude model.
  for (const key of Object.keys(env)) if (/^ANTHROPIC_(DEFAULT_.*MODEL|MODEL|SMALL_FAST_MODEL)/.test(key)) delete env[key];
  const path = profilePath(i);
  if (path && (i.configDir || process.env[profiles[i.provider]])) env[profiles[i.provider]] = path;
  // HOME remains intact, including the native keychain location.
  return env;
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function loginCommand(i: ProviderInstance) {
  const path = i.configDir || process.env[profiles[i.provider]] ? profilePath(i) : undefined;
  const args = i.provider === 'claude-code' ? ['auth', 'login'] : ['login'];
  // This is guidance only. Credential exchange/storage stays entirely in the native CLI.
  return `${path ? `mkdir -p ${quote(path)} && ` : ''}env ${commonOverrides.map((k) => `-u ${k}`).join(' ')} ${path ? `${profiles[i.provider]}=${quote(path)} ` : ''}${quote(expandPath(i.binaryPath))} ${args.join(' ')}`;
}
