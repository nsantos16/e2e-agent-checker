import { z } from 'zod';

export function readTeamConfig(env: NodeJS.ProcessEnv = process.env) {
  const input = z
    .object({
      TEAM_DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:/.test(v)),
      TEAM_PUBLIC_URL: z.url(),
      TEAM_CLERK_PUBLISHABLE_KEY: z.string().regex(/^pk_(test|live)_/),
      TEAM_CLERK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/),
      TEAM_CLERK_ORGANIZATION_ID: z.string().regex(/^org_/),
      TEAM_CLERK_WEBHOOK_SECRET: z.string().min(1).optional(),
      TEAM_HOST: z.string().default('127.0.0.1'),
      TEAM_PORT: z.coerce.number().int().min(1).max(65535).default(4200),
      TEAM_SERVE_UI: z.enum(['true', 'false']).default('true'),
    })
    .parse(env);
  const url = new URL(input.TEAM_PUBLIC_URL);
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('TEAM_PUBLIC_URL must be an origin');
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  ) {
    throw new Error('TEAM_PUBLIC_URL requires HTTPS outside localhost');
  }
  if (
    input.TEAM_CLERK_SECRET_KEY.startsWith('sk_live_') !==
    input.TEAM_CLERK_PUBLISHABLE_KEY.startsWith('pk_live_')
  )
    throw new Error('Clerk keys must belong to the same environment');
  if (
    env.NODE_ENV === 'production' &&
    !input.TEAM_CLERK_SECRET_KEY.startsWith('sk_live_')
  )
    throw new Error('Production requires Clerk production keys');
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new Error('Production requires an HTTPS public URL');
  return {
    databaseUrl: input.TEAM_DATABASE_URL,
    publicUrl: url.origin,
    host: input.TEAM_HOST,
    port: input.TEAM_PORT,
    clerkPublishableKey: input.TEAM_CLERK_PUBLISHABLE_KEY,
    clerkSecretKey: input.TEAM_CLERK_SECRET_KEY,
    clerkOrganizationId: input.TEAM_CLERK_ORGANIZATION_ID,
    webhookSecret: input.TEAM_CLERK_WEBHOOK_SECRET,
    serveUi: input.TEAM_SERVE_UI === 'true',
  };
}
export type TeamConfig = ReturnType<typeof readTeamConfig>;
