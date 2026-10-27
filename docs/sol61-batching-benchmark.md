# GPT-6.1-Sol batching benchmark — October 26, 2026

**This experiment did not establish an improvement.** The candidate used fewer tool invocations, but returned more bytes, consumed more tokens and had a higher median elapsed time. Both versions also failed the independent quality requirement on the persistence workflow.

The subsequent [revision and new 30-run comparison](sol61-batching-revision-benchmark.md) address these problems. This report preserves the original experiment and its negative result.

## Results

These are actual model-driven exploration → codification → stabilization → replay runs, not scripted tool sequences. There were 30 measured workflows: three cases × five paired repetitions × two versions, with 60 model stages. All stages resolved to `gpt-6.1-sol`, medium reasoning, standard (`default`) service tier. The measured experiment took 45.0 minutes including the separate assertion audits. A two-run form pilot was excluded before the measured experiment began.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Median workflow elapsed time, all runs | 69.20 s | 80.02 s |
| Median tool invocations per workflow | 19 | 15 |
| Median serialized tool-result bytes per workflow | 22,991 | 42,772 |
| Median provider-reported total tokens per workflow | 105,512 | 156,701 |
| Median input tokens, including cached tokens | 103,671 | 154,451 |
| Median cached input tokens | 76,544 | 101,120 |
| Median output tokens | 1,878 | 2,277 |
| Runs meeting the complete quality requirement | 10/15 | 10/15 |
| Total tool invocations across 15 runs | 307 | 211 |
| Total serialized tool-result bytes across 15 runs | 560,287 | 818,322 |
| Total stabilization attempts across 15 runs | 16 | 20 |

Comparing pooled medians, calls decreased **21.1%**, while elapsed time increased **15.6%**, result bytes increased **86.0%**, and total tokens increased **48.5%**. The candidate was slower in 14 of the 15 raw elapsed-time pairs. Raw elapsed comparisons include quality failures and are descriptive; they are not the acceptance score.

The predeclared acceptance target was at least 15% median paired improvement, a positive lower bound on a 95% bootstrap interval, and every candidate meeting the quality requirement. Incorrect runs receive the predeclared 600-second cap in the time-to-correct score. Its median paired improvement was **−12.1%**, with a stratified paired bootstrap 95% interval of **[−23.4%, 0.0%]**. Positive values mean improvement. The performance target and the quality requirement both failed. The interval includes no change; this is not a claim of a proven inference-latency regression.

| Workflow | Baseline median time | Candidate median time | Baseline / candidate median calls | Baseline / candidate median bytes | Qualified runs, baseline / candidate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Form save/reset, dense reference list | 63.38 s | 78.05 s | 17 / 15 | 67,894 / 76,913 | 5/5 / 5/5 |
| Conditional EU checkout wizard | 64.39 s | 77.93 s | 25 / 16 | 22,488 / 42,772 | 5/5 / 5/5 |
| Deliberate multiline persistence defect | 76.14 s | 85.70 s | 19 / 12 | 21,006 / 42,691 | 0/5 / 0/5 |

## Assertions were checked independently

All 30 runs produced the expected exploration state, verdicts and nominal replay outcome. That alone would have hidden a quality problem. The generated tests also faced **310 independent mutation/control checks; 290 behaved as required**. Each case assertion had a corresponding injected defect. The persistence case additionally had a repaired control that had to pass, preventing an unconditional failure from receiving credit.

Every persistence test, in both versions, silently accepted `clear-note` and `clear-status` defects. Inspection found that generated tests placed these assertions inside `cleanup(...)`, whose shared helper catches exceptions. Those assertions therefore did not fail a repaired application when its cleanup behavior was wrong. This is an observed weakness in both versions, not evidence that batching introduced it. The shared codification instructions require best-effort cleanup; a future revision must distinguish that housekeeping from a case's explicit cleanup assertions. The measured prompts were not changed to fix this during the experiment.

The 20 form/wizard runs caught all their injected assertion defects. Failed runs were retained, not replaced or rerun for a more favorable result.

## What the traces show

| Stage, median across 15 runs per version | Baseline time | Candidate time | Baseline / candidate calls | Baseline / candidate bytes |
| --- | ---: | ---: | ---: | ---: |
| Exploration | 28.40 s | 35.19 s | 11 / 6 | 8,329 / 12,081 |
| Codification and stabilization | 34.09 s | 40.14 s | 9 / 9 | 15,572 / 34,641 |

Stage medians do not sum to the median whole workflow. The complete workflow also includes independent replay and packaging.

The candidate made 62 `browser_batch`, 30 `read_inputs` and 42 `qa_tool_result` calls. Detail retrieval was a real cost: complete history and helpers often needed more than their grouped previews. There were also 20 candidate stabilization attempts versus 16 baseline attempts. These observations describe the tested package; they do not isolate each component's causal contribution.

The baseline was free to use existing browser code execution and provider-supported concurrent tool requests. For example, `form-3-baseline/codify/rpc-timing.jsonl` records six input requests within 5 ms. Its candidate partner requested grouped reads at 0 and 3,546 ms, then detail pages at 6,155 and 6,158 ms. Counting the six baseline tools as six model round trips would be misleading. This experiment reports service invocations, not an asserted count of inference requests. It measures actual model-driven workflow latency, but does not directly measure server-side inference latency. The recorded provider-and-orchestration residual still includes transport and orchestration.

The earlier [scripted benchmark](tool-batching.md) demonstrated fewer calls and bytes for a prescribed sequence without a model. The live result shows why those savings cannot be assumed to carry through to autonomous workflows.

## Method and evidence

- Original tools/prompts at commit `ba15ae4` versus the frozen implementation worktree. Both used the common Codex adapter and replay orchestration. No tool strategy was forced. The implementation, prompts and benchmark source hashes were recorded before measurement and verified afterward.
- Fresh ephemeral provider sessions and isolated browser contexts. Pair order alternated; workflow pairs were shuffled with seed `20261026`. Runs were serial to avoid benchmark-run contention. Normal provider caching remained enabled and its usage was recorded.
- Same cases, expected values, browser, helper, two stabilization attempts, 80-tool-call stage limit and 600-second workflow deadline. Timing starts before exploration service initialization and ends after independent replay/packaging. The mutation audit occurs afterward, outside the primary timer. Its shorter assertion timeouts do not change stabilization/replay settings.
- The analysis uses paired workflow/repetition log ratios and 20,000 stratified paired bootstrap samples, seed `442601`. The failed persistence pairs receive equal 600-second scores; they are not treated as successful fast workflows.
- Apple M4 Pro, Darwin 24.6.0 arm64, Node v26.7.0, Codex CLI 0.164.0, repository Playwright 1.61.1 and Playwright MCP 0.0.83. This is one machine and session with three localhost fixtures, not a production workload survey. Claude's adapter has protocol coverage, but no Claude model latency was measured in this experiment.

Raw artifacts are in `runs/sol61-model-benchmark-p8WBR7/` in the implementation worktree:

- `manifest.json`, `results.json`, `analysis.json`, `supplemental-analysis.json` and `progress.jsonl`.
- `source/` contains hash-verified copies of the measured source files. Each workflow has a copy of its final `generated.spec.ts`, verified against its stabilization hash.
- Each stage retains its prompt, transcript, tool arguments/results, native usage, resolved model settings and timing. Each workflow retains observations, stabilization/replay artifacts and mutation-audit results.
- Pilot evidence is separate under `runs/sol61-model-benchmark-RUmTb8/`. It had 15 versus 12 tool calls and 67.62 versus 70.05 seconds, with both quality checks passing.

See [benchmark execution instructions](../tests/README.md#live-gpt-61-sol-comparison). The reusable harness is [model-batching-benchmark.ts](../tests/model-batching-benchmark.ts), with [fixtures and the independent oracle](../tests/fixtures/model-benchmark.ts) and [paired analysis](../tests/model-benchmark-analysis.ts).

After the experiment, `npm test` passed all 51 tests and `npm run check` passed. These cover batching order, early termination, cancellation, evidence retrieval, complete action history, redaction and both provider adapters; passing implementation tests does not override the negative live benchmark result.
