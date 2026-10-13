import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateUsdCost, type Pricing } from 'tokentally';
import { loadLiteLlmCatalog, resolveLiteLlmPricing, type LiteLlmLoadResult } from 'tokentally/node';
import { claudeUsage, mergeUsage, type Usage } from './usage.ts';

export type RunPricing = { price: (usage: Usage, model: string) => Usage };
let cached: { expires: number; value: Promise<LiteLlmLoadResult> } | undefined;
async function loadCatalog(): Promise<LiteLlmLoadResult> {
  if (!cached || cached.expires < Date.now()) {
    cached = {
      expires: Date.now() + 60_000,
      value: loadLiteLlmCatalog({
        env: process.env,
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(3_000) }),
      }).catch(() => ({ catalog: null, source: 'none' as const })),
    };
  }
  return cached.value;
}
// Capture once for both model stages. Only the rates actually used are stored with the run.
export async function createRunPricing(runDir: string, loaded?: LiteLlmLoadResult): Promise<RunPricing> {
  const { catalog, source } = loaded ?? (await loadCatalog());
  const snapshot = {
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    catalog: 'LiteLLM',
    catalogSource: source,
    catalogHash: catalog ? createHash('sha256').update(JSON.stringify(catalog)).digest('hex') : null,
    basis: 'standard-api',
    library: 'tokentally@0.1.7',
    models: {} as Record<string, Pricing | null>,
  };
  const save = () => writeFileSync(join(runDir, 'pricing.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  save();
  return {
    price(usage, model) {
      if (!Object.hasOwn(snapshot.models, model)) {
        snapshot.models[model] = catalog ? resolveLiteLlmPricing(catalog, model) : null;
        save();
      }
      const pricing = snapshot.models[model];
      const out = { ...usage, estimatedApiCostUsd: null, pricingSnapshotId: snapshot.id } as Usage;
      if (!pricing || usage.inputTokens === null || usage.outputTokens === null || usage.cacheReadTokens === null) return out;
      const writes = usage.cacheWriteTokens ?? 0;
      const uncached = usage.inputTokens - usage.cacheReadTokens - writes;
      if (uncached < 0) return out;
      // Provider adapters retain inclusive input counts; reasoning is already part of output.
      const estimate = estimateUsdCost({
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          uncachedInputTokens: uncached,
          cachedInputTokens: usage.cacheReadTokens,
          cacheCreationInputTokens: writes,
        },
        pricing,
        requireExplicitUncachedInputTokens: true,
      });
      out.estimatedApiCostUsd = estimate && Number.isFinite(estimate.totalUsd) ? estimate.totalUsd : null;
      return out;
    },
  };
}

// Claude can use several models in a stage. Price the final model breakdown only when it reconciles.
export function priceClaudeResult(
  usage: Usage,
  modelUsage: Record<string, any> | undefined,
  models: string[],
  pricing?: RunPricing,
): Usage {
  if (!pricing) return usage;
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length) {
    const parts = entries.map(([model, u]) =>
      pricing.price(
        claudeUsage({
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_read_input_tokens: u.cacheReadInputTokens,
          cache_creation_input_tokens: u.cacheCreationInputTokens,
        }),
        model,
      ),
    );
    const combined = mergeUsage(parts);
    if (
      combined.inputTokens === usage.inputTokens &&
      combined.outputTokens === usage.outputTokens &&
      combined.cacheReadTokens === usage.cacheReadTokens &&
      combined.cacheWriteTokens === usage.cacheWriteTokens
    ) {
      return { ...usage, estimatedApiCostUsd: combined.estimatedApiCostUsd, pricingSnapshotId: combined.pricingSnapshotId };
    }
    // Never attribute an inconsistent multi-model breakdown to one model.
    return usage;
  }
  return models.length === 1 ? pricing.price(usage, models[0]!) : usage;
}
