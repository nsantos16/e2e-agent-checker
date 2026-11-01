import { z } from 'zod';

// Shared by HTTP, MCP and the UI. No credential values belong in this contract.
export const speechVoices = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;
export const textModels = ['gpt-6-luna', 'haiku'] as const;
export const voiceOptionsSchema = z
  .object({
    enabled: z.boolean(),
    textModel: z.enum(textModels),
    speechModel: z.literal('gpt-realtime-2.1-mini'),
    voice: z.enum(speechVoices),
  })
  .strict();
export type VoiceOptions = z.infer<typeof voiceOptionsSchema>;
export const defaultVoiceOptions: VoiceOptions = {
  enabled: false,
  textModel: 'gpt-6-luna',
  speechModel: 'gpt-realtime-2.1-mini',
  voice: 'marin',
};
export const voiceOverrideSchema = voiceOptionsSchema.partial();
export const credentialReferenceSchema = z
  .string()
  .max(500)
  .refine(
    (v) => /^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(v) || /^op:\/\/[^/\r\n]+\/[^/\r\n]+\/[^\r\n]+$/.test(v),
    'Use env://VARIABLE_NAME or op://vault/item/field; never a secret value',
  );
export const saveVoiceSettingsSchema = z
  .object({
    expectedRevision: z.string(),
    options: voiceOptionsSchema,
    speechCredentialRef: credentialReferenceSchema.nullable(),
  })
  .strict();
export const generateDemoSchema = z
  .object({
    voice: voiceOverrideSchema.optional(),
    retry: z.boolean().default(false),
  })
  .strict();
export type VoiceSettings = VoiceOptions & {
  revision: string;
  speechCredentialRef: string | null;
};
export type VoiceReadiness = {
  settings: VoiceSettings;
  speech: {
    status: 'not-configured' | 'missing' | 'configured';
    verified: false;
  };
  // A configured reference is not proof of provider access. Checking it never makes a speech call.
};
export const sessionIdSchema = z.string().regex(/^[\w-]{1,128}$/);
export const createSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    jobIds: z.array(sessionIdSchema).max(240).default([]),
  })
  .strict();
export const addSessionRunsSchema = z
  .object({
    expectedRevision: z.string(),
    jobIds: z.array(sessionIdSchema).min(1).max(240),
  })
  .strict();
export const publishSchema = z
  .object({
    jobId: sessionIdSchema.optional(),
    sessionId: sessionIdSchema.optional(),
    pr: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/),
    publish: z.literal(true),
    video: z.enum(['silent', 'narrated', 'none']).default('silent'),
  })
  .strict()
  .refine((v) => !!v.jobId !== !!v.sessionId, 'Provide exactly one of jobId or sessionId');
