# Usage and API-equivalent pricing

The checker keeps provider-reported token usage as its source of truth. `tokentally@0.1.7` performs the dollar calculation using LiteLLM standard API rates. The UI shows **API-equivalent cost** when this estimate is available, falls back to explicitly labeled **Reported cost**, and shows **Unavailable** when neither is known. These figures do not establish a subscription charge; `billedCostUsd` remains unknown.

Claude input counts exclude cache reads/writes, so the adapter adds them into inclusive input. Codex input counts already include cached input. Pricing subtracts cache reads/writes from inclusive input, then prices each category once. Reasoning remains a subset of output and is not charged again. Repeated Codex cumulative updates replace the previous stage estimate; repeated Claude message IDs replace prior message snapshots. Stages are summed once.

Claude's final per-model usage is priced separately only when its counts reconcile with the aggregate result. Single-model results can use the observed model ID. Aliases such as `sonnet` are not guessed into a priced model; actual resolved model IDs are required. Missing usage, missing cache-read counts, inconsistent cache subsets, unknown models, and incomplete mixed-model attribution produce an unavailable estimate. A known provider-reported cost remains separate. Partial runs retain estimates for recorded tokens with partial usage status. Replay-only runs have zero model tokens and zero estimated model cost.

## Pricing snapshots

Before model execution, each verification captures one catalog for both exploration and codification. The library uses a seven-day disk cache (`TOKENTALLY_CACHE_DIR`, otherwise `~/.tokentally/cache`), falling back to cached prices if a refresh fails. Network fetches have a three-second timeout. The process shares concurrent loads for one minute. If no usable catalog is available, verification continues without estimates.

`runs/<run>/pricing.json` records a snapshot ID, capture time, catalog source (cache/network/none), catalog content hash, library version, standard-rate basis, and the per-token rates for every model requested during that run. The capture time is when the run selected prices, not a claim that the upstream catalog was updated then. Rates remain fixed throughout the run; existing runs are not repriced after catalog changes. `usage.json` and stage metrics retain estimated and reported costs separately. `pricingSnapshotId` links a stage/run estimate to its rates. Historical runs are not backfilled with today's prices.

These are standard API estimates. They do not model fast/priority tiers, long-context surcharges, regional routing, discounts, tool/search fees, or subscription quotas. If a cache rate is absent, tokentally uses the ordinary input rate. Missing token categories remain unknown in reported usage; an omitted optional cache-write field is treated as zero for estimation.

## Agent access

Normal `get_job`, `list_jobs`, and `wait_jobs` responses include compact usage and the snapshot ID. Fetch details only when needed:

```json
{"jobId":"job-...","artifact":"pricing"}
```

Pass this to `get_evidence`; `artifact:"usage"` returns the per-stage accounting. Both artifacts support the existing bounded text paging and download links.

## Sources

- [tokentally](https://github.com/steipete/tokentally)
- [T3 Code pricing implementation](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts)
- [T3 Code usage semantics](https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md)
