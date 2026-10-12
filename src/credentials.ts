import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import sdk from '@1password/sdk';
import { config as appConfig } from './config.ts';

// See docs/adr/0002: secrets are resolved here, in the harness, and never reach the agent.
// Service account when OP_SERVICE_ACCOUNT_TOKEN is set, otherwise desktop-app auth (one approval per process).
// SDK desktop auth needs "Integrate with other apps" enabled in the 1Password app; without it we fall back to `op read`,
// which uses the CLI's desktop integration.

type RoleRefs = { description: string; username: string; password: string; totp?: string };
type RolesConfig = { roles: Record<string, RoleRefs> };

export type Credentials = {
  username: string;
  password: string;
  // TOTP codes rotate every 30s, so they are resolved at the moment they are typed.
  totp?: () => Promise<string>;
};

const config: RolesConfig = JSON.parse(readFileSync(new URL('../config/roles.json', import.meta.url), 'utf8'));

type Resolver = (ref: string) => Promise<string>;

const opRead: Resolver = async (ref) => {
  const { stdout } = await promisify(execFile)('op', ['read', '--no-newline', '--account', appConfig.onePasswordAccount, ref]);
  return stdout;
};

let resolverPromise: Promise<Resolver> | undefined;

const resolver = () => {
  resolverPromise ??= sdk
    .createClient({
      auth: process.env.OP_SERVICE_ACCOUNT_TOKEN ?? new sdk.DesktopAuth(appConfig.onePasswordAccount),
      integrationName: 'e2e-agent-checker',
      integrationVersion: '0.0.1',
    })
    .then((c): Resolver => (ref) => c.secrets.resolve(ref))
    .catch((error) => {
      if (process.env.OP_SERVICE_ACCOUNT_TOKEN) throw error;
      console.warn(`1Password SDK desktop auth unavailable (${error}); falling back to the op CLI`);
      return opRead;
    });
  return resolverPromise;
};

export const resolveRole = async (role: string): Promise<Credentials> => {
  const refs = config.roles[role];
  if (!refs) throw new Error(`Unknown role "${role}". Known: ${Object.keys(config.roles).join(', ')}`);
  const resolve = await resolver();
  const [username, password] = await Promise.all([resolve(refs.username), resolve(refs.password)]);
  const totpRef = refs.totp;
  return { username, password, totp: totpRef ? () => resolve(totpRef) : undefined };
};
