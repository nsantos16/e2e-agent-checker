import type { JobView, Provider, Target } from './types.ts';
export const STAGES = ['prepare', 'explore', 'codify', 'replay', 'package'];
export const outcomeLabel: Record<string, string> = { pass: 'Passed', fail: 'Failed', blocked: 'Blocked', 'codify-failed': 'Not codified' };
export const terminal = (job: Pick<JobView, 'status'>) => !['queued', 'running', 'cancelling'].includes(job.status);
export const number = (n: number | null | undefined) => (n == null ? 'Unavailable' : n.toLocaleString());
export const duration = (ms: number | null | undefined) =>
  ms == null || !Number.isFinite(ms)
    ? '—'
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
export const dollars = (n: number | null | undefined) => (n == null ? 'Unavailable' : `$${n.toFixed(4)}`);
export const shortTime = (date: string) => {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60000));
  return mins < 1 ? 'now' : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
};
export const modelName = (target: Target, providers: Provider[]) =>
  providers.find((p) => p.id === target.provider)?.models.find((m) => m.id === target.model)?.name ?? target.model;
export const caseKey = (c: { project: string; id: number }) => `${c.project}-${c.id}`;
export const providerMark = { codex: 'Cx', 'claude-code': 'Cl', cursor: 'Cu' };
export function providerMessage(p: Provider) {
  if (p.ready) return 'Connected. Runs use your existing subscription.';
  if (p.id === 'cursor' && p.auth === 'subscription' && p.reason?.startsWith('CAPABILITY_UNSUPPORTED'))
    return 'Cursor is connected, but its runtime does not yet support the tool restrictions required for verification. You can use the checker MCP from Cursor with Codex as the worker.';
  if (p.auth === 'api-key')
    return 'An API key is active. Sign in with your subscription, then restart the checker without the provider API-key environment variable.';
  return p.reason?.replace(/^[A-Z_]+:\s*/, '') ?? 'Sign in through the native app to connect.';
}
