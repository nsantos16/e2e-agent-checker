export type Usage = {
  status: 'pending' | 'partial' | 'complete' | 'unavailable';
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  providerReportedCostUsd: number | null;
  estimatedApiCostUsd: number | null;
  billedCostUsd: number | null;
  pricingSnapshotId: string | null;
  source: string;
};
export const emptyUsage = (source = 'none', status: Usage['status'] = 'pending'): Usage => ({
  status,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  providerReportedCostUsd: null,
  estimatedApiCostUsd: null,
  billedCostUsd: null,
  pricingSnapshotId: null,
  source,
});
export const noModelUsage = (source: 'replay' | 'saved-spec'): Usage => ({
  ...emptyUsage(source, 'complete'),
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  providerReportedCostUsd: 0,
  estimatedApiCostUsd: 0,
});
const num = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
export const claudeUsage = (u: Record<string, unknown>, cost?: unknown, complete = false): Usage => {
  const input = num(u.input_tokens),
    read = num(u.cache_read_input_tokens),
    write = num(u.cache_creation_input_tokens),
    output = num(u.output_tokens);
  const allInput = input === null ? null : input + (read ?? 0) + (write ?? 0);
  return {
    ...emptyUsage('claude'),
    status: complete ? 'complete' : 'partial',
    inputTokens: allInput,
    outputTokens: output,
    totalTokens: allInput === null || output === null ? null : allInput + output,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    providerReportedCostUsd: num(cost),
  };
};
export const codexUsage = (u: Record<string, unknown>, complete = false): Usage => ({
  ...emptyUsage('codex'),
  status: complete ? 'complete' : 'partial',
  inputTokens: num(u.inputTokens),
  outputTokens: num(u.outputTokens),
  totalTokens: num(u.totalTokens),
  cacheReadTokens: num(u.cachedInputTokens),
  cacheWriteTokens: num(u.cacheWriteInputTokens),
  reasoningTokens: num(u.reasoningOutputTokens),
});
export const mergeUsage = (values: Usage[]): Usage => {
  if (!values.length) return emptyUsage();
  const out = emptyUsage([...new Set(values.map((v) => v.source))].join('+'));
  out.status = values.every((v) => v.status === 'complete')
    ? 'complete'
    : values.some((v) => v.status === 'partial' || v.status === 'complete')
      ? 'partial'
      : values.some((v) => v.status === 'pending')
        ? 'pending'
        : 'unavailable';
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'providerReportedCostUsd',
    'estimatedApiCostUsd',
    'billedCostUsd',
  ] as const)
    out[key] = values.every((v) => v[key] !== null) ? values.reduce((sum, v) => sum + v[key]!, 0) : null;
  const ids = [...new Set(values.map((v) => v.pricingSnapshotId))];
  out.pricingSnapshotId = ids.length === 1 ? ids[0]! : null;
  return out;
};
export type RunMetrics = { costUsd: number | null; turns: number; toolCalls: number; wallMs: number; models: string[]; usage: Usage };
