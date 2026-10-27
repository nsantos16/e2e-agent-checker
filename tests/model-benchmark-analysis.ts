export type BenchmarkRow = {
  id: string;
  workflow: string;
  repetition: number;
  variant: 'baseline' | 'candidate';
  elapsedMs: number;
  correct: boolean;
  errors: string[];
  stages: Record<string, any>;
  audit?: any;
};
export const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function summarizeModelBenchmark(rows: BenchmarkRow[], deadlineMs = 600_000, expectedPairs?: number) {
  const metric = (r: BenchmarkRow, key: string) => Object.values(r.stages).reduce((sum, s) => sum + (s[key] ?? 0), 0);
  const token = (r: BenchmarkRow, key: string) => Object.values(r.stages).reduce((sum, s) => sum + (s.metrics?.usage?.[key] ?? 0), 0);
  const groups = ['all', ...new Set(rows.map((r) => r.workflow))].flatMap((workflow) =>
    ['baseline', 'candidate'].map((variant) => {
      const selected = rows.filter((r) => (workflow === 'all' || r.workflow === workflow) && r.variant === variant);
      return {
        workflow,
        variant,
        runs: selected.length,
        correct: selected.filter((r) => r.correct).length,
        elapsedMedianMs: median(selected.map((r) => r.elapsedMs)),
        cappedCompletionMedianMs: median(selected.map((r) => (r.correct ? r.elapsedMs : deadlineMs))),
        toolCallsMedian: median(selected.map((r) => metric(r, 'toolCalls'))),
        resultBytesMedian: median(selected.map((r) => metric(r, 'resultBytes'))),
        toolMsMedian: median(selected.map((r) => metric(r, 'toolMs'))),
        providerAndOrchestrationMsMedian: median(selected.map((r) => metric(r, 'providerAndOrchestrationMs'))),
        totalTokensMedian: median(selected.map((r) => token(r, 'totalTokens'))),
        inputTokensMedian: median(selected.map((r) => token(r, 'inputTokens'))),
        outputTokensMedian: median(selected.map((r) => token(r, 'outputTokens'))),
        cachedTokensMedian: median(selected.map((r) => token(r, 'cacheReadTokens'))),
        toolCounts: selected.reduce(
          (all, r) => {
            for (const s of Object.values(r.stages))
              for (const [name, count] of Object.entries(s.toolCounts ?? {})) all[name] = (all[name] ?? 0) + Number(count);
            return all;
          },
          {} as Record<string, number>,
        ),
      };
    }),
  );
  const pairs = rows
    .filter((r) => r.variant === 'baseline')
    .flatMap((baseline) => {
      const candidate = rows.find(
        (r) => r.variant === 'candidate' && r.workflow === baseline.workflow && r.repetition === baseline.repetition,
      );
      if (!candidate) return [];
      const baselineMs = baseline.correct ? baseline.elapsedMs : deadlineMs,
        candidateMs = candidate.correct ? candidate.elapsedMs : deadlineMs;
      return [
        {
          workflow: baseline.workflow,
          repetition: baseline.repetition,
          baseline: baseline.id,
          candidate: candidate.id,
          baselineCorrect: baseline.correct,
          candidateCorrect: candidate.correct,
          rawSpeedup: 1 - candidate.elapsedMs / baseline.elapsedMs,
          scoreSpeedup: 1 - candidateMs / baselineMs,
          logRatio: Math.log(candidateMs / baselineMs),
        },
      ];
    });
  const strata = [...new Set(pairs.map((p) => p.workflow))].map((w) => pairs.filter((p) => p.workflow === w));
  const rng = random(442601),
    bootstrap: number[] = [];
  if (pairs.length)
    for (let i = 0; i < 20_000; i++) {
      const sample = strata.flatMap((stratum) => stratum.map(() => stratum[Math.floor(rng() * stratum.length)].logRatio));
      bootstrap.push(1 - Math.exp(median(sample)!));
    }
  bootstrap.sort((a, b) => a - b);
  const effect = {
    pairedMedianSpeedup: pairs.length ? 1 - Math.exp(median(pairs.map((p) => p.logRatio))!) : null,
    ci95: bootstrap.length ? [bootstrap[Math.floor(bootstrap.length * 0.025)], bootstrap[Math.floor(bootstrap.length * 0.975)]] : null,
  };
  const complete = pairs.length > 0 && pairs.length * 2 === rows.length && (expectedPairs === undefined || pairs.length === expectedPairs);
  const correctnessGate = complete && pairs.every((p) => p.candidateCorrect);
  return {
    groups,
    pairs,
    ...effect,
    complete,
    correctnessGate,
    meetsTarget: correctnessGate && effect.pairedMedianSpeedup! >= 0.15 && effect.ci95![0] > 0,
    method:
      'Pair by workflow/repetition. Failures remain in all tables and receive the predeclared 600s cap for time-to-correct scoring. Median paired log ratio; 20,000 stratified paired bootstrap samples with seed 442601 and percentile 95% interval. Correctness requires every candidate to meet the independent oracle and mutation audit. Raw elapsed times alone can reward fast failures and are descriptive only.',
  };
}
