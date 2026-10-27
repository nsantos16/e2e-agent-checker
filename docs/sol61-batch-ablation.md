# Generic browser batching: controlled comparison

**Decision: remove the generic `browser_batch` API.** Keep grouped input reads, compact results, sanitized evidence, complete action history, cancellation safeguards and the corrected browser/codification guidance. Known browser sequences use the existing Playwright code-execution tool.

The added API saved three tool invocations across 15 workflows and did not establish a latency benefit. Both versions satisfied every quality check. This follows the decision rule recorded before the comparison: retain generic batching if it meets the performance target; otherwise select the simpler interface when its qualification rate is no worse.

## Measured result

The experiment ran October 26–27, 2026 UTC: three workflow patterns × five paired repetitions × two versions, with 60 native model stages. Every stage resolved to **GPT-6.1-Sol, medium reasoning, standard (`default`) service tier**. Total experiment time, including independent assertion audits, was 51.75 minutes.

Both arms used the same frozen revised implementation. The control omitted `browser_batch` from the tool catalog, rejected direct requests to it, and removed its accompanying prompt paragraph. The full arm exposed it. Other tool definitions were verified identical for every pair. Both arms retained the fixes from the [previous revision](sol61-batching-revision-benchmark.md).

| Metric | Without generic batch | With generic batch |
| --- | ---: | ---: |
| Fully qualified workflows | 15/15 | 15/15 |
| Independent assertion/control checks satisfied | 155/155 | 155/155 |
| Median whole-workflow elapsed time | 58.00 s | 56.75 s |
| Median tool invocations | 11 | 11 |
| Total tool invocations | 156 | 153 |
| Median serialized result bytes | 31,531 | 31,520 |
| Total serialized result bytes | 490,694 | 490,113 |
| Median provider-reported total tokens | 104,117 | 105,680 |
| Stabilization attempts | 15 | 15 |
| Exploration tools exposed | 26 | 27 |
| Serialized exploration tool-definition bytes | 18,051 | 19,165 |

The **median paired timing improvement from adding generic batching was −0.4%, with a 95% bootstrap interval of [−1.7%, +4.0%]**. Positive means the full version is faster. It was faster in seven of 15 pairs. The pooled median times differ by 2.2%; comparing pooled medians is not the paired estimate. All runs qualified, so raw elapsed time and the predeclared time-to-correct score coincide.

The performance target required at least 15% paired improvement and a positive lower confidence bound, alongside complete candidate qualification. Quality passed; performance did not. This establishes neither a latency advantage nor universal equivalence. It supports choosing the simpler interface for the tested workloads.

Generic batching reduced total invocations by 1.9% and total result bytes by 581 bytes (0.12%). Median tokens were 1.5% higher with it. Counts were cross-checked against the provider's RPC tool requests. They are tool invocations, not inferred model round trips. Tokens are provider-reported and include cached input; no cost or inference-only latency claim follows from them.

| Workflow | Without: median elapsed / calls | With: median elapsed / calls | Qualified without / with |
| --- | ---: | ---: | ---: |
| Form save/reset with a dense reference list | 49.07 s / 8 | 47.05 s / 8 | 5/5 / 5/5 |
| Conditional EU checkout wizard | 58.00 s / 12 | 56.34 s / 11 | 5/5 / 5/5 |
| Deliberate multiline persistence defect | 76.39 s / 11 | 76.67 s / 11 | 5/5 / 5/5 |

These are representative UI patterns in disposable localhost fixtures, not a survey of production applications. The model chose its tools freely. The batch API was used four times, all in the wizard, to fill billing fields and click Review. That click supplied the updated page snapshot. The control grouped the same operations in existing code and then requested a snapshot. This was an observed benefit in some wizard runs, but it did not establish an overall timing advantage.

Both arms completed all 15 grouped input reads without errors or truncation. Each made five detail requests to inspect the deliberate persistence failures. All ten persistence tests caught the cleanup defects and passed the repaired control. One full-version form run submitted an empty native code request, received a rejection, inspected the page, then continued successfully. Its recovery calls and time remain included.

## Setup-timeout investigation

The [previous experiment](sol61-batching-revision-benchmark.md) retained one failed audit: a 25-second timeout while creating a browser context, before any assertion ran. Its original row remains unqualified.

A separate diagnostic used that same hash-verified generated spec, all 15 form mutants and an unchanged control. Three runs with one worker and three with three workers satisfied **96/96 checks**, with no setup stalls. The cause of the original stall remains unknown; these diagnostics do not establish that worker count or batching caused it.

The new comparison serialized audit workers in both arms to reduce contention. It retained the same 25-second test, 1.5-second expectation, three-second action and five-second navigation timeouts, with no retries. Audits remain outside the primary workflow timer. No measured failure was replaced, discarded or retried into a success.

## Selected implementation and validation

The final implementation removes the generic batch schema, custom result comparisons/modal flags, and multi-action dispatch loop. Existing browser calls still validate arguments, execute under the stage lock, stop and halt on uncertain timeout/cancellation/transport outcomes, and never automatically retry mutations. Known sequences use sequential awaits and explicit checks in the existing code tool. Independent allowed-file reads remain grouped, with successful siblings preserved when another entry fails.

The single-call result/evidence envelope remains compatible. A code snippet is one driver invocation: the wrapper records the complete submitted attempt and all driver-reported code, but does not invent completion statuses for individual statements inside opaque code. Detailed evidence is saved before results are compacted. Both Codex dynamic tools and Claude stage MCP expose the same reduced tool catalog, preserving their isolation settings.

The live experiment measured the interface omission against the frozen full implementation. Afterward, the unused batch implementation was removed. A separate nine-scenario comparison checked that ordinary single-call success, errors, dialogs, timeouts, transport rejection, cancellation and validation retain the same outcomes. **55/55 repository tests and `npm run check` pass**, including both provider adapters, ordering, cancellation, evidence retrieval, action-log completeness, response bounds and redaction. The real browser/network/stabilization/replay smoke check also passes. The live latency figures are from the frozen interface comparison, not a second model run after the internal simplification.

The final scripted browser benchmark also passes all six unchanged checks in five repetitions per mode. Existing code execution uses one tool/driver call, 541 result bytes and 565.27 ms median, versus six calls, 67,801 bytes and 1,165.86 ms for raw individual forwarding. A negative control throws before a second save and verifies that the save count remains one. This demonstrates local execution savings for that known sequence; it makes no model calls and cannot establish a model-latency improvement. Full input reads use six versus one call and 5,514 versus 6,897 bytes; grouping still has metadata overhead. See [the scripted measurements](tool-batching.md#final-scripted-measurement).

Before publication, the change was rebased onto `main` at `f3f8c2b`, retaining the newer navigation readiness, stabilization evidence reuse and saved-spec reuse behavior. The combined version passes **111/111 tests**, `npm run check`, the real browser/network smoke and the stabilization evidence smoke (including saved-spec replay after promotion). A new regression covers request cancellation marking the exact attempt ineligible while leaving the stage usable. These integration checks are separate from the frozen model measurements above; no additional model-latency claim is made for the combined version.

## Reproduction and retained evidence

- `runs/sol61-batch-ablation-9U9OKy/` contains the predeclared manifest, original results/analysis, supplemental analysis, resolved model settings, tool catalogs, prompts, transcripts, tool results, usage, observations, stabilization/replay and audit artifacts. All 32 source copies and all 30 final generated specs were hash-verified; see `source-verification.json`.
- `runs/browser-setup-investigation-kNxvZF/` contains the separate six-run worker-count diagnostic, frozen-spec hash, configs, context-fixture events and all 96 outcomes.
- `runs/observation-smoke-NF25oK/` contains the final real-browser smoke artifacts.
- `runs/tool-batching-benchmark-qOwLSP/benchmark.json` contains the final scripted measurements and equivalent assertion counts.
- The frozen full implementation is retained in the isolated sibling worktree `../e2e-agent-checker-batching-full`. The main implementation worktree is `../e2e-agent-checker-batching`; the original checkout's unrelated changes are preserved.

To repeat the comparison, run `node tests/model-batching-benchmark.ts --ablation --baseline /absolute/path/to/frozen-full-worktree`. The supplied full checkout must still expose `browser_batch`; the harness derives the control from it. It uses fresh ephemeral model sessions and browser contexts, a fixed shuffled pair order (seed `20261026`), the same 80-call stage and two-attempt limits, and a 600-second workflow deadline. Primary timing covers exploration service initialization through independent replay/packaging. Analysis uses 20,000 stratified paired bootstrap samples (seed `442601`). No pilot or earlier experiment is pooled into these results.

See the [current tool contract](tool-batching.md) and [test instructions](../tests/README.md#live-gpt-61-sol-comparison). Earlier experiments remain unchanged and separately identified.
