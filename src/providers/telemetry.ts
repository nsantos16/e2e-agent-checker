import { createHash } from 'node:crypto';
import type { Account, Limit } from './schema.ts';
export const accountFingerprint = (account: Account) =>
  account.id || account.email
    ? createHash('sha256')
        .update(JSON.stringify([account.id, account.email, account.organization]))
        .digest('hex')
    : undefined;
export const nativeText = (x: unknown) => (typeof x === 'string' ? x.slice(0, 250) : undefined);
export const codexAccount = (a: any): Account => ({
  id: nativeText(a?.accountId ?? a?.id),
  email: nativeText(a?.email),
  plan: nativeText(a?.planType),
});
export function codexLimits(value: any): Limit[] {
  const buckets = value?.rateLimitsByLimitId ?? (value?.rateLimits ? { codex: value.rateLimits } : {});
  return Object.entries(buckets).flatMap(([id, raw]) => {
    const bucket = raw as any;
    return ['primary', 'secondary'].flatMap((name) => {
      const w = bucket?.[name];
      if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return [];
      return [
        {
          name: `${id} ${name}`,
          usedPercent: w.usedPercent,
          ...(typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? { resetsAt: w.resetsAt } : {}),
          exhausted: w.usedPercent >= 100 && (!w.resetsAt || w.resetsAt * 1000 > Date.now()),
        },
      ];
    });
  });
}

// Redact credential-shaped fields without dropping token counters or model text.
// This is only for persisted diagnostics; protocol processing uses the original event.
export function redactProviderEvent(value: unknown): string {
  const secrets = Object.entries(process.env)
    .filter(([key, v]) => /(?:api.?key|token|secret|password)/i.test(key) && v && v.length >= 8)
    .map(([, v]) => v!);
  return JSON.stringify(value, (key, v) => {
    if (/^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|cookie|credentials|password|secret)$/i.test(key))
      return '[redacted]';
    if (typeof v !== 'string') return v;
    let text = v
      .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/((?:password|secret|token|api[-_]?key|authorization|cookie)\s*[=:]\s*)[^\s&,;]+/gi, '$1[redacted]');
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    return text;
  });
}
