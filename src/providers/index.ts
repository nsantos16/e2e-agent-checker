import { z } from 'zod';
import { command } from '../process.ts';
import { codexConnection } from './rpc.ts';
export const providerId = z.enum(['claude-code', 'codex', 'cursor']);
export const targetSchema = z
  .object({ provider: providerId, model: z.string().min(1).max(120), authMode: z.literal('subscription').default('subscription') })
  .strict();
export type Target = z.infer<typeof targetSchema>;
export type Provider = {
  id: Target['provider'];
  name: string;
  installed: boolean;
  auth: 'subscription' | 'api-key' | 'unknown' | 'logged-out';
  ready: boolean;
  reason?: string;
  loginCommand: string;
  models: { id: string; name: string }[];
};
export class RunError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = code;
  }
}
export async function inspectProvider(id: Target['provider']): Promise<Provider> {
  const p: Provider = {
    id,
    name: { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' }[id],
    installed: false,
    auth: 'unknown',
    ready: false,
    loginCommand: { 'claude-code': 'claude auth login', codex: 'codex login', cursor: 'agent login' }[id],
    models: [],
  };
  try {
    if (id === 'claude-code') {
      const r = await command('claude', ['auth', 'status', '--json'], { timeoutMs: 10_000 });
      const a = JSON.parse(r.stdout);
      p.installed = true;
      p.auth = !a.loggedIn
        ? 'logged-out'
        : a.authMethod === 'api_key'
          ? 'api-key'
          : a.authMethod === 'oauth_token' || a.authMethod === 'claude.ai'
            ? 'subscription'
            : 'unknown';
      p.models = ['sonnet', 'opus', 'haiku'].map((id) => ({ id, name: id }));
    } else if (id === 'codex') {
      const rpc = await codexConnection();
      try {
        const a = await rpc.request('account/read', { refreshToken: false });
        p.installed = true;
        p.auth = a.account?.type === 'chatgpt' ? 'subscription' : a.account?.type === 'apiKey' ? 'api-key' : 'logged-out';
        let cursor: string | null = null;
        do {
          const page = await rpc.request('model/list', { limit: 100, cursor, includeHidden: false });
          p.models.push(...page.data.map((m: any) => ({ id: m.model, name: m.displayName })));
          cursor = page.nextCursor;
        } while (cursor);
      } finally {
        await rpc.close();
      }
    } else {
      const r = await command('agent', ['status', '--format', 'json'], { timeoutMs: 10_000 });
      const a = JSON.parse(r.stdout);
      p.installed = true;
      p.auth = process.env.CURSOR_API_KEY ? 'api-key' : a.isAuthenticated ? 'subscription' : 'logged-out';
      if (p.auth === 'subscription')
        p.reason =
          'CAPABILITY_UNSUPPORTED: Cursor ACP inherits user MCP servers and native tools; isolated tool permissions are not verified. Runs are disabled.';
    }
    if (!p.reason)
      p.reason =
        p.auth === 'api-key'
          ? 'AUTH_MODE_MISMATCH: native runtime uses an API key. Sign in with your subscription.'
          : p.auth !== 'subscription'
            ? 'AUTH_REQUIRED: subscription login is required.'
            : undefined;
    p.ready = !p.reason;
  } catch (e) {
    p.reason = `PROVIDER_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}`;
  }
  return p;
}
let cached: { expires: number; value: Promise<Provider[]> } | undefined;
export const listProviders = (fresh = false) => {
  if (fresh || !cached || cached.expires < Date.now())
    cached = { expires: Date.now() + 30_000, value: Promise.all(providerId.options.map(inspectProvider)) };
  return cached.value;
};
export async function preflight(target: Target) {
  const p = await inspectProvider(target.provider);
  if (!p.ready) throw new RunError(p.reason?.split(':')[0] ?? 'PROVIDER_UNAVAILABLE', p.reason ?? 'Provider unavailable');
  if (!p.models.some((m) => m.id === target.model))
    throw new RunError('MODEL_UNAVAILABLE', `${target.model} is not in ${p.name}'s model catalog`);
  return p;
}
