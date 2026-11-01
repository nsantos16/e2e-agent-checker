import { Effect, type Scope } from 'effect';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { commandEffect, type ProcessRunner } from '../process.ts';
import { runClaudeEffect, type ClaudeOutcome, type ClaudeRun } from '../claude.ts';
import { stageToolsEffect, type StageConfig } from '../stage-tools.ts';
import { runCodexEffect } from './codex.ts';
import { codexConnectionEffect } from './rpc.ts';
import { expandPath, instanceEnvironment } from './instances.ts';
import { nativeText as text, codexAccount, codexLimits } from './telemetry.ts';
import { RunError } from './errors.ts';
import type { Account, Provider, ProviderInstance, ProviderKind, Target } from './schema.ts';

type Probe = Pick<Provider, 'auth' | 'models'> & Partial<Provider>;
const cmd = (i: ProviderInstance, args: string[], input?: string) =>
  commandEffect(expandPath(i.binaryPath), args, {
    cwd: tmpdir(),
    env: instanceEnvironment(i),
    timeoutMs: 10_000,
    input,
  });
export const claudeIsolationArgs = [
  '--restricted',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--settings',
  '{"disableAllHooks":true}',
];
const claudeProbe = (i: ProviderInstance) =>
  Effect.gen(function* () {
    const r = yield* cmd(i, ['--restricted', 'auth', 'status', '--json']);
    if (!r.stdout.trim()) throw new Error(r.stderr);
    const a = JSON.parse(r.stdout);
    const auth = !a.loggedIn
      ? 'logged-out'
      : a.authMethod === 'api_key'
        ? 'api-key'
        : ['oauth_token', 'claude.ai'].includes(a.authMethod) && (!a.apiProvider || a.apiProvider === 'firstParty')
          ? 'subscription'
          : 'unknown';
    const account: Account = { id: text(a.accountId), email: text(a.email), organization: text(a.orgId), plan: text(a.subscriptionType) };
    const base: Probe = { auth, account, models: [], catalogSource: 'unavailable' };
    if (auth !== 'subscription') return base;
    // A control-only initialize returns the installed CLI's catalog; no user message or model turn.
    const response = yield* cmd(
      i,
      [...claudeIsolationArgs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', ''],
      JSON.stringify({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } }) + '\n',
    );
    const control = response.stdout
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s))
      .find((e) => e.type === 'control_response' && e.response?.request_id === 'catalog')?.response;
    if (response.code !== 0 || control?.subtype !== 'success' || !Array.isArray(control.response?.models))
      throw new RunError(
        'CAPABILITY_UNSUPPORTED',
        'This Claude binary did not return a control-only model catalog. Update Claude Code, then refresh.',
      );
    return {
      ...base,
      catalogSource: 'native' as const,
      models: control.response.models.flatMap((m: any) =>
        typeof m.value === 'string'
          ? [
              {
                id: m.value,
                name: text(m.displayName) ?? m.value,
                resolvedModel: text(m.resolvedModel),
                efforts: Array.isArray(m.supportedEffortLevels)
                  ? m.supportedEffortLevels.filter((e: unknown) => typeof e === 'string')
                  : [],
              },
            ]
          : [],
      ),
    };
  });
const codexProbe = (i: ProviderInstance) =>
  Effect.scoped(
    Effect.gen(function* () {
      const rpc = yield* codexConnectionEffect(tmpdir(), i);
      const a = yield* rpc.requestEffect('account/read', { refreshToken: false }, 10_000);
      const auth = a.account?.type === 'chatgpt' ? 'subscription' : a.account?.type === 'apiKey' ? 'api-key' : 'logged-out';
      const result: Probe = { auth, account: codexAccount(a.account), models: [], catalogSource: 'unavailable' };
      if (auth !== 'subscription') return result;
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: any = yield* rpc.requestEffect('model/list', { limit: 100, cursor, includeHidden: false }, 10_000);
        if (!Array.isArray(page.data)) throw new Error('Invalid model catalog');
        result.models.push(
          ...page.data
            .filter((m: any) => typeof m.model === 'string')
            .map((m: any) => ({
              id: m.model,
              name: text(m.displayName) ?? m.model,
              efforts: (m.supportedReasoningEfforts ?? []).map((v: any) => v.reasoningEffort).filter((v: unknown) => typeof v === 'string'),
              defaultEffort: text(m.defaultReasoningEffort),
            })),
        );
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size > 30)) throw new Error('Invalid model pagination');
        if (cursor) seen.add(cursor);
      } while (cursor);
      result.catalogSource = 'native';
      const limits = yield* rpc
        .requestEffect('account/rateLimits/read', undefined, 3000)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      result.limits = limits ? codexLimits(limits) : undefined;
      const exhausted = result.limits?.find((l) => l.exhausted && l.name.startsWith('codex '));
      if (!result.reason && exhausted)
        result.reason = `USAGE_EXHAUSTED: Native provider reported a usage limit.${exhausted.resetsAt ? ` Resets ${new Date(exhausted.resetsAt * 1000).toISOString()}.` : ''}`;
      return result;
    }),
  );
const cursorProbe = (i: ProviderInstance) =>
  Effect.gen(function* () {
    const r = yield* cmd(i, ['status', '--format', 'json']);
    const a = JSON.parse(r.stdout);
    return {
      auth: a.isAuthenticated ? ('subscription' as const) : ('logged-out' as const),
      models: [],
      catalogSource: 'unavailable' as const,
      account: { email: text(a.email) },
      reason:
        'CAPABILITY_UNSUPPORTED: Cursor is authenticated independently of execution. Native ACP tool and MCP isolation is not verified; runs remain disabled.',
    };
  });
export type HarnessRun = ClaudeRun & { stageConfig?: StageConfig };
const claudeStart = (run: HarnessRun, i: ProviderInstance, target: Target) =>
  Effect.gen(function* () {
    let mcpConfigPath = run.mcpConfigPath;
    if (run.stageConfig) {
      const dir = dirname(run.transcriptPath),
        configPath = join(dir, 'stage-config.json');
      writeFileSync(configPath, JSON.stringify(run.stageConfig), { mode: 0o600 });
      mcpConfigPath = join(dir, 'runtime-mcp.json');
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            stage: {
              command: process.execPath,
              args: [new URL('../stage-mcp.ts', import.meta.url).pathname, configPath],
            },
          },
        }),
        { mode: 0o600 },
      );
    }
    return yield* runClaudeEffect({
      ...run,
      instance: i,
      target,
      model: target.resolvedModel ?? target.model,
      cwd: dirname(run.transcriptPath),
      tools: [''],
      allowedTools: run.stageConfig ? ['mcp__stage'] : [],
      addDirs: [],
      mcpConfigPath,
    });
  });
const codexStart = (run: HarnessRun, i: ProviderInstance, target: Target) =>
  Effect.gen(function* () {
    const service = run.stageConfig
      ? yield* stageToolsEffect(run.stageConfig, run.signal)
      : {
          tools: [],
          call: async () => {
            throw new Error('Tool not permitted');
          },
          close: async () => {},
        };
    return yield* runCodexEffect({ ...run, instance: i, target, model: target.model }, service);
  });
const capabilities = (execution: boolean, configDir = true) => ({
  execution,
  toolIsolation: execution,
  models: execution,
  auth: 'native-command' as const,
  configDir,
});
// Provider protocols and stage-tool controls belong to adapters, not jobs or UI.
export type HarnessAdapter = {
  probe: (instance: ProviderInstance) => Effect.Effect<Probe, Error, ProcessRunner | Scope.Scope>;
  start: (run: HarnessRun, instance: ProviderInstance, target: Target) => Effect.Effect<ClaudeOutcome, Error, ProcessRunner | Scope.Scope>;
  capabilities: ReturnType<typeof capabilities>;
};
export const harnesses: Record<ProviderKind, HarnessAdapter> = {
  'claude-code': { probe: claudeProbe, start: claudeStart, capabilities: capabilities(true) },
  codex: { probe: codexProbe, start: codexStart, capabilities: capabilities(true) },
  cursor: {
    probe: cursorProbe,
    start: (_run: HarnessRun, _i: ProviderInstance, _target: Target) =>
      Effect.fail(new RunError('CAPABILITY_UNSUPPORTED', 'Cursor execution is gated until tool isolation is verified.')),
    capabilities: capabilities(false, false),
  },
};
