import { z } from 'zod';

export const providerId = z.enum(['claude-code', 'codex', 'cursor']);
export type ProviderKind = z.infer<typeof providerId>;
export const instanceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const defaultInstanceId = (kind: ProviderKind) => `${kind}-default`;
export const launchOptionsSchema = z.object({ effort: z.string().min(1).max(40).optional() }).strict();
export const targetSchema = z
  .object({
    provider: providerId,
    instanceId: instanceIdSchema.optional(),
    instanceRevision: z.string().min(1).max(100).optional(),
    accountFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    model: z.string().min(1).max(120),
    resolvedModel: z.string().min(1).max(120).optional(),
    authMode: z.literal('subscription').default('subscription'),
    options: launchOptionsSchema.optional(),
  })
  .strict();
export type Target = z.infer<typeof targetSchema>;
const nativePath = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((s) => !/[\x00-\x1f]/.test(s), 'Use a native path, without control characters');
export const instanceConfigSchema = z
  .object({
    id: instanceIdSchema,
    provider: providerId,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    binaryPath: nativePath,
    configDir: nativePath.optional(),
    // Only typed launch options: arbitrary flags could override billing or tool isolation.
    options: launchOptionsSchema.default({}),
  })
  .strict();
export type InstanceConfig = z.infer<typeof instanceConfigSchema>;
export type ProviderInstance = InstanceConfig & { revision: string };
export const saveInstanceSchema = z.object({ instance: instanceConfigSchema, expectedRevision: z.string().optional() }).strict();
export const instanceActionSchema = z.object({ instanceId: instanceIdSchema, expectedRevision: z.string().min(1) }).strict();
export type Model = { id: string; name: string; resolvedModel?: string; efforts?: string[]; defaultEffort?: string };
export type Account = { id?: string; email?: string; organization?: string; plan?: string };
export type Limit = { name: string; usedPercent?: number; resetsAt?: number; exhausted?: boolean };
export type Provider = {
  /** Legacy driver identifier. New consumers route by instanceId. */
  id: ProviderKind;
  name: string;
  installed: boolean;
  auth: 'subscription' | 'api-key' | 'unknown' | 'logged-out';
  ready: boolean;
  reason?: string;
  loginCommand: string;
  models: Model[];
  instanceId?: string;
  revision?: string;
  config?: ProviderInstance;
  selected?: boolean;
  version?: string;
  account?: Account;
  accountFingerprint?: string;
  checkedAt?: string;
  catalogSource?: 'native' | 'native-aliases' | 'unavailable';
  capabilities?: { execution: boolean; toolIsolation: boolean; models: boolean; auth: 'native-command'; configDir: boolean };
  ignoredEnvironment?: string[];
  limits?: Limit[];
};
export const targetInstanceId = (t: Pick<Target, 'provider' | 'instanceId'>) => t.instanceId ?? defaultInstanceId(t.provider);
export const providerInstanceId = (p: Provider) => p.instanceId ?? defaultInstanceId(p.id);
export const sameTarget = (a: Target, b: Target) => targetInstanceId(a) === targetInstanceId(b) && a.model === b.model;
