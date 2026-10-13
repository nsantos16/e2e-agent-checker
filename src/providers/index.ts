import { Cause, Context, Data, Effect, Layer } from 'effect';
import { runEffect } from '../runtime/effect.ts';
import { z } from 'zod';
import { commandEffect, ProcessRunnerLive } from '../process.ts';
import { codexConnectionEffect } from './rpc.ts';
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
export class RunError extends Data.TaggedError('RunError')<{ code: string; message: string }> {
  constructor(code: string, message: string) {
    super({ code, message });
  }
}
const inspect = (id: Target['provider']) =>
  Effect.scoped(
    Effect.gen(function* () {
      const p: Provider = {
        id,
        name: { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' }[id],
        installed: false,
        auth: 'unknown',
        ready: false,
        loginCommand: { 'claude-code': 'claude auth login', codex: 'codex login', cursor: 'agent login' }[id],
        models: [],
      };
      if (id === 'claude-code') {
        const r = yield* commandEffect('claude', ['auth', 'status', '--json'], { timeoutMs: 10_000 });
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
        const rpc = yield* codexConnectionEffect();
        const a = yield* rpc.requestEffect('account/read', { refreshToken: false });
        p.installed = true;
        p.auth = a.account?.type === 'chatgpt' ? 'subscription' : a.account?.type === 'apiKey' ? 'api-key' : 'logged-out';
        let cursor: string | null = null;
        do {
          const page: { data: { model: string; displayName: string }[]; nextCursor: string | null } = yield* rpc.requestEffect(
            'model/list',
            { limit: 100, cursor, includeHidden: false },
          );
          p.models.push(...page.data.map((m: any) => ({ id: m.model, name: m.displayName })));
          cursor = page.nextCursor;
        } while (cursor);
      } else {
        const r = yield* commandEffect('agent', ['status', '--format', 'json'], { timeoutMs: 10_000 });
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
      return p;
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.succeed({
            id,
            name: { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' }[id],
            installed: false,
            auth: 'unknown' as const,
            ready: false,
            models: [],
            loginCommand: { 'claude-code': 'claude auth login', codex: 'codex login', cursor: 'agent login' }[id],
            reason: `PROVIDER_UNAVAILABLE: ${String(Cause.squash(cause))}`,
          } satisfies Provider),
    ),
  );
export class ProviderRegistry extends Context.Service<ProviderRegistry, { inspect: typeof inspect }>()('checker/ProviderRegistry') {}
export const ProviderRegistryLive = Layer.succeed(ProviderRegistry, { inspect });
export const inspectProviderEffect = (id: Target['provider']) => Effect.flatMap(ProviderRegistry, (registry) => registry.inspect(id));
export const inspectProvider = (id: Target['provider']) =>
  runEffect(inspectProviderEffect(id).pipe(Effect.provide(ProviderRegistryLive), Effect.provide(ProcessRunnerLive)));
const allProviders = Effect.all(providerId.options.map(inspectProviderEffect), { concurrency: 3 });
const [cachedProviders, invalidateProviders] = Effect.runSync(Effect.cachedInvalidateWithTTL(allProviders, '30 seconds'));
export const listProvidersEffect = (fresh = false) => (fresh ? Effect.andThen(invalidateProviders, cachedProviders) : cachedProviders);
export const listProviders = (fresh = false) =>
  runEffect(listProvidersEffect(fresh).pipe(Effect.provide(ProviderRegistryLive), Effect.provide(ProcessRunnerLive)));
export const preflightEffect = (target: Target) =>
  Effect.gen(function* () {
    const p = yield* inspectProviderEffect(target.provider);
    if (!p.ready)
      return yield* Effect.fail(new RunError(p.reason?.split(':')[0] ?? 'PROVIDER_UNAVAILABLE', p.reason ?? 'Provider unavailable'));
    if (!p.models.some((m) => m.id === target.model))
      return yield* Effect.fail(new RunError('MODEL_UNAVAILABLE', `${target.model} is not in ${p.name}'s model catalog`));
    return p;
  });
export const preflight = (target: Target) =>
  runEffect(preflightEffect(target).pipe(Effect.provide(ProviderRegistryLive), Effect.provide(ProcessRunnerLive)));
