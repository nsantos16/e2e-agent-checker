# GPT-6.1-Sol batching revision — October 26, 2026

The revision fixes the repeated input reads, undersized previews, duplicated source text, guessed browser locators and swallowed cleanup assertions found in the [first experiment](sol61-batching-benchmark.md). The new comparison has lower elapsed-time medians, fewer calls and more qualified workflows. **It still does not meet the strict acceptance gate or establish an inference-latency improvement.** One candidate assertion audit timed out during browser setup; that failure remains in the measured dataset.

The later [controlled comparison of the generic batch component](sol61-batch-ablation.md) qualified all 30 workflows and selected removal of `browser_batch`. The other fixes remain. This report preserves the earlier experiment unchanged.

## Changes and observed behavior

- Grouped reads authorize and read each file independently. Missing or forbidden entries return individual errors while preserving successful siblings. Tool descriptions disclose whether the generated spec exists at stage start. Tests cover both adapters and mixed valid/missing/forbidden inputs.
- Previews use the actual serialized 24 KiB response budget. Short files finish first and leave more room for longer files. Bounded detail pages return original sanitized text with continuation offsets, avoiding nested JSON and rereading the preview. Tests reconstruct escaped Unicode input exactly across pages and a reloaded evidence store.
- Exploration prefers existing Playwright code execution for known sequences, with sequential awaits and explicit assertions. Locators use observed snapshot roles and accessible names; the prompt distinguishes these from HTML label text. A batch remains available when a sequence needs different tools.
- The source view contains every driver-reported code block once, concise outcomes and evidence IDs. Full submitted arguments, responses, failures and uncertain outcomes remain in the authoritative action log and saved evidence before compaction. A regression test verifies both views.
- Explicit case cleanup assertions stay outside the best-effort housekeeping helper, including when an earlier case step fails. The original failure is preserved if cleanup also fails.

All 15 revised codification stages obtained their inputs in one successful `read_inputs` call, with **zero truncated inputs and zero recovery reads**. The five detail calls retrieved the deliberate persistence failure, one per persistence run; none fetched omitted file text. There were 48 existing code-execution calls and four `browser_batch` calls. The only five revised browser-tool errors were the five deliberate persistence assertion failures; there were no incidental locator/assertion failures during exploration.

This contrasts with the first candidate's 30 grouped reads, 42 detail calls and 20 stabilization attempts. The revised candidate required 15 stabilization attempts, one per workflow. Historical comparisons describe the traces; the new paired baseline below is the comparison used for this experiment.

## New live comparison

Thirty complete workflows: three cases × five paired repetitions × two versions, with 60 native model stages. Every stage resolved to `gpt-6.1-sol`, medium reasoning, standard (`default`) service tier. The experiment took 41.97 minutes including the separate assertion audits. The baseline remains commit `ba15ae4`; candidate source was frozen before the first measured run and verified afterward.

| Metric | Baseline | Revised candidate |
| --- | ---: | ---: |
| Median workflow elapsed time, all runs | 70.03 s | 58.09 s |
| Median tool invocations per workflow | 20 | 11 |
| Median serialized result bytes per workflow | 22,480 | 31,696 |
| Total tool invocations, 15 workflows | 313 | 153 |
| Total serialized result bytes, 15 workflows | 585,000 | 481,292 |
| Median provider-reported total tokens | 114,419 | 104,150 |
| Median input tokens, including cached tokens | 112,565 | 102,142 |
| Median cached input tokens | 73,600 | 69,504 |
| Median output tokens | 1,854 | 2,008 |
| Complete quality qualification | 9/15 | 14/15 |
| Independent mutation/control checks satisfied | 140/155 | 154/155 |
| Stabilization attempts | 19 | 15 |

Pooled median elapsed time decreased 17.0%, median calls decreased 45.0% and median total tokens decreased 9.0%. Total result bytes decreased 17.7%, **but median result bytes increased 41.0%**. The form's large snapshots account for much of the total saving; smaller workflows still pay for evidence metadata, source outcomes and failure details. This is not a universal byte reduction. Relative to the first candidate, total bytes decreased 41.2%, a historical rather than randomized comparison.

| Workflow | Baseline median time | Revised median time | Median calls, baseline / revised | Median bytes, baseline / revised | Qualified, baseline / revised |
| --- | ---: | ---: | ---: | ---: | ---: |
| Form save/reset, dense reference list | 68.49 s | 51.32 s | 19 / 8 | 76,293 / 31,696 | 4/5 / 4/5 |
| Conditional EU checkout wizard | 63.89 s | 58.09 s | 25 / 11 | 22,480 / 27,939 | 5/5 / 5/5 |
| Deliberate multiline persistence defect | 73.66 s | 79.62 s | 19 / 11 | 20,957 / 36,415 | 0/5 / 5/5 |

The persistence workflow takes longer and returns more detail, while now satisfying the cleanup assertion checks that all five baseline tests missed. Its raw elapsed times therefore compare different achieved quality; they must not be presented as a pure speed win.

| Stage, median across 15 runs per version | Baseline time | Revised time | Median calls, baseline / revised | Median bytes, baseline / revised |
| --- | ---: | ---: | ---: | ---: |
| Exploration | 30.48 s | 27.30 s | 12 / 7 | 8,329 / 7,712 |
| Codification and stabilization | 32.46 s | 24.22 s | 8 / 3 | 15,681 / 20,513 |

Stage medians do not sum to the median whole workflow, which also includes independent replay and packaging.

## What is and is not established

The predeclared time-to-correct score assigns each unqualified workflow 600 seconds. Its median paired improvement is **34.4%, with a 95% stratified paired bootstrap interval of [9.1%, 86.6%]**. That improvement includes the corrected persistence assertions and the baseline's failed form stabilization, not just execution speed. The target also required every candidate to qualify. Because one candidate did not, `correctnessGate` and `meetsTarget` remain **false**.

A separate descriptive analysis of raw elapsed times, including all quality failures, gives **8.7% median paired improvement, with a 95% interval of [−0.8%, 14.2%]**. The candidate was faster in nine of 15 pairs. The interval includes no improvement; the pooled 17.0% median decrease is not the paired estimate. Neither statistic measures pure server-side model inference latency.

Calls here are tool invocations, not inferred model round trips. The baseline can already issue concurrent independent input reads and use browser code execution. Provider-and-orchestration residuals still include transport and orchestration. This experiment measures the combined tool/prompt revision; it does not isolate each change's causal effect or establish performance on production applications or Claude models.

## Retained failure and separate diagnostic

All 15 revised workflows produced the required exploration state, stabilization outcome and independent replay outcome. In `form-0-candidate`, the `initial-email` mutation audit exceeded its 25-second test timeout **while setting up the browser context**, before the assertion ran. The other 14 mutation checks for that workflow satisfied the audit. Its row remains unqualified and receives the 600-second score.

After the frozen experiment finished, a separate diagnostic ran that one mutant against the same hash-verified generated spec and a fresh localhost fixture. It retained the 25-second test, 1.5-second assertion, three-second action and five-second navigation timeouts, with no retries. Running one project meant effectively one worker rather than the original audit's three concurrent projects. The email assertion failed in Step 1 with expected `qa@example.test`, received `wrong`, as required. This supports the diagnosis of a setup failure in the original audit; it does not replace its measurement or make the strict gate pass.

All five revised persistence tests caught both cleanup defects and passed the repaired control. The baseline missed both cleanup defects in every repetition. A separate baseline form run failed stabilization and replay because its save-count locator was incorrect; the audit also rejected its cleanup mutants failing at the wrong step. All failures remain included.

## Method, artifacts and validation

The cases, exact expected values, independent observation oracle, mutation/control checks, two-attempt limit, 80-call stage limit and 600-second workflow deadline are unchanged from the first experiment. Fresh ephemeral model sessions and isolated browser contexts are used for each workflow. Pair order alternates; pairs are shuffled with seed `20261026`. Workflows run serially. Normal provider caching remains enabled and is recorded. The primary timer covers exploration service startup through independent replay/packaging; mutation audits run afterward. Bootstrap analysis uses 20,000 stratified paired samples with seed `442601`.

A development pilot was stopped after an exact HTML-label locator timed out on the wizard's select. The prompt was corrected to prefer observed role/name locators. A fresh six-run pilot then qualified all three revised workflows. Both pilots are excluded from the frozen experiment and retained separately; no measured row was discarded or replaced. Only the pilot selection changed in the harness, from one workflow pair to one pair per workflow; the main experiment's protocol and scoring did not change.

The machine/runtime matches the first experiment: Apple M4 Pro, Darwin 24.6.0 arm64, Node v26.7.0, Codex CLI 0.164.0, Playwright 1.61.1 and Playwright MCP 0.0.83. These are five repetitions of three localhost workflows in one session, not a broad workload survey.

Artifacts in the implementation worktree:

- `runs/sol61-model-benchmark-qV3FCJ/`: manifest, original results/analysis, supplemental analysis, prompts, transcripts, native usage/timing, tool results, observations, replay and audit artifacts. `source/` contains 29 hash-verified source copies, and every workflow has its final generated spec copied and verified against its stabilization hash. `source-verification.json` records verification.
- `runs/sol61-model-benchmark-qV3FCJ/form-0-candidate/assertion-diagnostic/`: separate diagnostic config, observations, report, log and `diagnostic.json`. Original measured results are unchanged.
- `runs/sol61-model-benchmark-dbVj1s/`: stopped development pilot and reason. `runs/sol61-model-benchmark-I8gAYa/`: complete six-run pilot.
- `runs/observation-smoke-sIAlZx/`: passing real Playwright MCP/network/stabilization/replay smoke check.

The repeated no-model tool benchmark is `runs/tool-batching-benchmark-v12jMT/benchmark.json`. Five repetitions per mode retained the same six browser calls and six assertions: raw forwarding used six tool invocations, 67,801 bytes and 1,154.50 ms median; compact batching used one invocation, 9,907 bytes and 1,162.19 ms. Complete input reads used six versus one invocation, 5,514 versus 6,897 bytes and 0.847 versus 0.858 ms. It demonstrates fewer invocations and browser-result bytes, not a local speed improvement or any model-latency improvement.

Final validation: **54/54 tests pass; `npm run check` passes.** Regression coverage includes ordering, early termination, cancellation, uncertain mutations without retries, detail pagination, complete action history, redaction, file boundaries and both Codex dynamic tools and Claude stage MCP adapters. The protocol tests exercise both providers; the live model comparison used Sol 6.1 only. See [execution instructions](../tests/README.md#live-gpt-61-sol-comparison) and the [tool contract](tool-batching.md).
