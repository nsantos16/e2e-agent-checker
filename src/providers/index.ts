import { Cause, Context, Effect, Layer } from 'effect';
import { runEffect, attempt } from '../runtime/effect.ts';
import { commandEffect, ProcessRunnerLive } from '../process.ts';
import { harnesses } from './adapters.ts';
import { accountFingerprint } from './telemetry.ts';
import { defaultInstanceId, targetInstanceId, targetSchema, type Target, type Provider, type ProviderInstance } from './schema.ts';
import {
  expandPath,
  getInstance,
  ignoredEnvironment,
  instanceEnvironment,
  instancesPath,
  loginCommand,
  readInstances,
} from './instances.ts';
import { RunError, nativeFailure } from './errors.ts';
import { tmpdir } from 'node:os';
export * from './schema.ts';
export { RunError } from './errors.ts';

const inspect = (id: Target['provider'], instance = getInstance(defaultInstanceId(id))) =>
  Effect.suspend(() => {
    if (instance.provider !== id) return Effect.fail(new RunError('INSTANCE_MISMATCH', 'Instance belongs to a different provider.'));
    const p: Provider = {
      id,
      instanceId: instance.id,
      revision: instance.revision,
      config: instance,
      name: instance.name,
      installed: false,
      auth: 'unknown',
      ready: false,
      loginCommand: loginCommand(instance),
      models: [],
      checkedAt: new Date().toISOString(),
      ignoredEnvironment: ignoredEnvironment(),
      capabilities: harnesses[id].capabilities,
    };
    if (!instance.enabled) return Effect.succeed({ ...p, reason: 'INSTANCE_DISABLED: Enable this instance in Settings.' });
    return Effect.scoped(
      Effect.gen(function* () {
        const version = yield* commandEffect(expandPath(instance.binaryPath), ['--version'], {
          env: instanceEnvironment(instance),
          cwd: tmpdir(),
          timeoutMs: 5000,
        });
        if (version.code !== 0) throw new Error('Version probe failed');
        p.installed = true;
        p.version = version.stdout.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0];
        Object.assign(p, yield* harnesses[id].probe(instance));
        p.accountFingerprint = p.account ? accountFingerprint(p.account) : undefined;
        p.reason ??=
          p.auth === 'api-key'
            ? 'AUTH_MODE_MISMATCH: The native profile uses API billing. Sign into this profile with your subscription.'
            : p.auth !== 'subscription'
              ? 'AUTH_REQUIRED: Sign into this native profile with your subscription.'
              : undefined;
        if (!p.reason && !p.accountFingerprint)
          p.reason =
            'ACCOUNT_UNVERIFIED: Native status did not expose an account identity. Update the native CLI and refresh before running.';
        p.ready = !p.reason;
        return p;
      }),
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        const error = nativeFailure(Cause.squash(cause));
        return Effect.succeed({
          ...p,
          models: [],
          catalogSource: 'unavailable' as const,
          ready: false,
          reason: `${error.code}: ${error.message}`,
        });
      }),
    );
  });
export class ProviderRegistry extends Context.Service<ProviderRegistry, { inspect: typeof inspect }>()('checker/ProviderRegistry') {}
export const ProviderRegistryLive = Layer.succeed(ProviderRegistry, { inspect });
export const inspectProviderEffect = (id: Target['provider'], instance?: ProviderInstance) =>
  Effect.flatMap(ProviderRegistry, (r) => r.inspect(id, instance));
export const inspectProvider = (id: Target['provider'], instanceId?: string) =>
  runEffect(
    inspectProviderEffect(id, instanceId ? getInstance(instanceId) : undefined).pipe(
      Effect.provide(ProviderRegistryLive),
      Effect.provide(ProcessRunnerLive),
    ),
  );
const generations = new Map<string, number>();
const cache = new Map<string, { at: number; value: Provider }>();
export const listProvidersEffect = (fresh = false, instanceId?: string) =>
  Effect.gen(function* () {
    const state = yield* attempt(readInstances);
    if (instanceId && !state.instances.some((i) => i.id === instanceId)) throw new RunError('INSTANCE_NOT_FOUND', 'Unknown instance.');
    return yield* Effect.forEach(
      state.instances.filter((i) => !instanceId || i.id === instanceId),
      (i) =>
        Effect.gen(function* () {
          const key = `${instancesPath()}:${i.id}`,
            entry = cache.get(key);
          let p = !fresh && entry && entry.value.revision === i.revision && Date.now() - entry.at < 30_000 ? entry.value : undefined;
          if (!p) {
            const generation = (generations.get(key) ?? 0) + 1;
            generations.set(key, generation);
            p = yield* inspectProviderEffect(i.provider, i);
            if (getInstance(i.id).revision !== i.revision)
              return { ...p, ready: false, models: [], reason: 'INSTANCE_CHANGED: Refresh this instance after its configuration change.' };
            if (generations.get(key) === generation) cache.set(key, { at: Date.now(), value: p });
          }
          return { ...p, selected: state.selectedInstanceId === i.id };
        }),
      { concurrency: 3 },
    );
  });
export const listProviders = (fresh = false, instanceId?: string) =>
  runEffect(listProvidersEffect(fresh, instanceId).pipe(Effect.provide(ProviderRegistryLive), Effect.provide(ProcessRunnerLive)));
export const preflightEffect = (input: Target) =>
  Effect.gen(function* () {
    const target = targetSchema.parse(input),
      instance = getInstance(targetInstanceId(target));
    if (instance.provider !== target.provider) throw new RunError('INSTANCE_MISMATCH', 'Instance belongs to a different provider.');
    if (target.instanceRevision && target.instanceRevision !== instance.revision)
      throw new RunError('INSTANCE_CHANGED', 'Instance configuration changed. Select it again before submitting new work.');
    if (!instance.enabled) throw new RunError('INSTANCE_DISABLED', 'This instance is disabled.');
    const p = yield* inspectProviderEffect(target.provider, instance);
    if (getInstance(instance.id).revision !== instance.revision)
      throw new RunError('INSTANCE_CHANGED', 'Instance changed during preflight. Refresh and retry.');
    if (!p.ready)
      return yield* Effect.fail(
        new RunError(
          p.reason?.split(':')[0] ?? 'PROVIDER_UNAVAILABLE',
          p.reason ?? 'Provider unavailable',
          p.limits?.find((l) => l.exhausted)?.resetsAt,
        ),
      );
    if (target.accountFingerprint && target.accountFingerprint !== p.accountFingerprint)
      throw new RunError('ACCOUNT_CHANGED', 'Native login changed since this run was selected. Select the account again for new work.');
    const model = p.models.find((m) => m.id === target.model);
    if (!model) throw new RunError('MODEL_UNAVAILABLE', `${target.model} is not in this instance’s model catalog`);
    if (target.resolvedModel && target.resolvedModel !== (model.resolvedModel ?? model.id))
      throw new RunError('MODEL_CHANGED', 'The native model alias changed. Select the model again for new work.');
    const options = target.options ?? instance.options;
    if (options.effort && !model.efforts?.includes(options.effort))
      throw new RunError('OPTION_UNAVAILABLE', 'The selected model does not advertise this effort option.');
    return {
      ...p,
      instance,
      target: {
        ...target,
        instanceId: instance.id,
        instanceRevision: instance.revision,
        accountFingerprint: p.accountFingerprint,
        resolvedModel: model.resolvedModel ?? model.id,
        options,
      } satisfies Target,
    };
  });
export const preflight = (target: Target) =>
  runEffect(preflightEffect(target).pipe(Effect.provide(ProviderRegistryLive), Effect.provide(ProcessRunnerLive)));
