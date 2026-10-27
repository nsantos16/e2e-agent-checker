# Bounded stage tools

Exploration groups known actions and assertions through the existing Playwright code-execution tool. Each driver call accepts at most 64 KiB of arguments and has a 120-second deadline. The exploration guidance maps observed snapshot roles/names to `getByRole`, avoids guessed DOM attributes/label parsing and requires sequential awaits and propagating assertion failures. Each complete call owns the stage lock, including browser reads. Only independent allowed-file reads in `read_inputs` run concurrently, with at most eight files and no overlapping spec writes or test runs.

Every browser request is validated against the currently exposed driver's schema before dispatch. Unknown tools and codification tools are rejected. Existing assertion/wait tools retain their checks; code sequences must throw on a failed check, stopping subsequent statements. The exploration prompt requires the case's expected-result checks inside the sequence and forbids speculative future element references. Dialog state remains inspectable in the driver's response; the model must inspect it before deciding how to continue.

Results identify completed, failed, uncertain or unexecuted driver calls and their evidence IDs. The existing envelope uses index 1 for the current call; a code snippet is one opaque invocation, and its individual statements are not separately instrumented. A failed call can have partially changed the page. Timeout, transport rejection or cancellation during dispatch is explicitly uncertain: the driver connection is closed before releasing the lock, and subsequent browser calls are rejected. Nothing automatically retries a mutation. Cancellation while waiting for the lock leaves that request unexecuted. Outcomes are saved even when the cancelling caller can no longer receive a reply. Legacy `batchEvidenceId` and history-kind names remain readable, but there is no generic `browser_batch` API.

The [controlled Sol 6.1 comparison](sol61-batch-ablation.md) selected this simpler interface: both versions qualified in all 15 workflows, while generic batching saved only three invocations and did not establish a timing advantage.

## Results and history

Text responses are limited to 24 KiB of serialized MCP result JSON. Browser summaries retain assertion outcomes, failure details, per-action result excerpts, network diagnostics and the latest returned page/snapshot state. Snapshot lines are kept whole so returned element references remain usable. `truncated`, `resultTruncated` and `stateOmitted` disclose missing content. When the driver returns an automatic snapshot file, only files canonically inside its configured output directory are expanded.

Before clipping, the service writes full dispatch arguments, responses and outcomes to `explore/actions.jsonl`. The `explore/actions.js` source view contains every driver-reported code block once, with concise start/outcome markers and evidence IDs. It does not repeat submitted code/values in comments. Full arguments and unsuccessful code remain recorded as attempts, not proof that every statement executed. Unexecuted calls do not contribute executable source. This also covers opaque driver code snippets: their internal statements are not independently instrumented, and the prompts require awaited sequential actions and propagating failed checks. A response lost in transit is recorded as uncertain rather than fabricated as a completed action.

Full text details live in `tool-results/<evidenceId>.json`, within the run. Text retains the driver's redaction and additionally scrubs configured secret values, credential fields, bearer tokens, JWTs and credential URL components without truncating source history. Ordinary locator/navigation URL parameters remain available; the existing stricter network URL policy remains in place. Directories are owner-only and files use mode `0600`. `qa_tool_result` accepts an opaque ID, not a path, checks canonical boundaries, and returns up to 8,000 UTF-16 characters with `nextOffset`. File/output evidence returns its original sanitized text (`format: "text"`); browser records and older evidence return JSON (`format: "json"`). Text preview cursors point into the same original text, so retrieval continues without resending the preview or adding a nested JSON encoding layer. The encoded response bound can shorten a page further. Follow the returned cursor rather than calculating the next offset.

Screenshots retain the driver's existing image behavior. At most one image, capped at 1 MiB encoded, is included inline in a tool reply. Action outcomes report `imageCount`; `qa_tool_result({ id, imageIndex: 0 })` retrieves a saved image without repeating the browser action. Up to eight image parts are retained per action; oversized images are saved but not sent to the model. Text pages contain image metadata rather than base64.

Codification gets `read_inputs`, existing `read_input`/`write_spec`/`try_spec`, captured network inspection and evidence retrieval. Each grouped file resolves and reads independently: missing or unauthorized entries return errors without discarding successful siblings. The tool descriptions disclose whether the generated spec exists at stage start. All content is returned when it fits the actual serialized 24 KiB budget; otherwise a shared budget lets short files finish and gives unused space to long ones. Entries retain order, truncation flags, total character counts and continuation cursors. Large inputs no longer silently lose everything after the old 100,000-character cutoff. Full stabilization output and assertion results are also saved, while the reply summarizes the attempt. Explicit case cleanup assertions must remain outside the best-effort housekeeping helper. Neither stage receives the other's execution tools or general filesystem access. The runner supplies the same run directory and service through Codex dynamic tools and Claude's stage MCP. Their existing shell, connector, delegation and MCP isolation settings remain unchanged. Both adapters forward cancellation to the service.

## Verification

`npm test` covers ordered calls and the stage lock, schema rejection before dispatch, native assertion outcomes and modal state, timeouts (including delayed abort-timer delivery), active/queued/pre-dispatch cancellation, no subsequent dispatch after uncertainty, complete code capture, locator and image retrieval, response limits, credential redaction and canonical file boundaries. Provider tests exercise Codex's RPC adapter with a controlled app-server process and Claude's real stage-MCP stdio transport, including success, errors, retrieval, isolation and cancellation. These are protocol tests, not live model runs.

`node tests/observability-smoke.ts` additionally exercises the actual Playwright MCP, live observation, sanitized network failures, stabilization and replay against localhost. `node tests/tool-batching-benchmark.ts` compares individual browser calls with the existing code-execution tool, writes its raw measurements under `runs/tool-batching-benchmark-*/benchmark.json`, and checks an intentionally incorrect assertion prevents a subsequent save inside the code call. It also compares individual/grouped complete input reads.

## Final scripted measurement

Five fresh browser contexts per mode, rotating mode order, with the same six browser operations and checks: fill two observed fields, save once, wait for the expected message, compare all four observed values and check the final accessibility snapshot. Common navigation and initial locator discovery are excluded. The code call uses sequential awaits and throws on every mismatch. Its negative control proves a failed assertion prevents a later save. Inputs are six complete files, compared byte for byte.

| Workflow | Tool / driver calls | Result bytes | Median local elapsed |
| --- | ---: | ---: | ---: |
| Browser, raw individual forwarding | 6 / 6 | 67,801 | 1,165.86 ms |
| Browser, compact individual calls | 6 / 6 | 28,348 | 1,156.19 ms |
| Browser, existing code-execution tool | 1 / 1 | 541 | 565.27 ms |
| Inputs, individual reads | 6 / 0 | 5,514 | 0.850 ms |
| Inputs, grouped reads | 1 / 0 | 6,897 | 0.901 ms |

Artifact: `runs/tool-batching-benchmark-qOwLSP/benchmark.json`. All modes retain six checks. These are local scripted measurements with **zero model calls**. They demonstrate fewer calls/bytes and lower local execution time for the prescribed browser sequence; they do not prove fewer inference requests or lower model latency. Grouped inputs still return more metadata bytes. The [live controlled comparison](sol61-batch-ablation.md) is the evidence for removing the extra generic batch API.

## Initial measurements, October 26, 2026 (before the follow-up fixes)

The [revision benchmark](sol61-batching-revision-benchmark.md) reports measurements after the input-budget, source-history and prompt fixes. The subsequent [component comparison](sol61-batch-ablation.md) selected removal of the generic batch API. The measurements below are historical and describe the earlier full implementation.

Five fresh browser contexts per mode, rotating execution order, Node v26.7.0 on macOS, `@playwright/mcp@0.0.83`. The browser workflow fills two observed fields, saves once, waits for the expected message, reads and checks all four state values, and checks the final snapshot. All modes perform the same six driver calls and six checks. Common navigation and locator discovery are excluded from timing and counts. The input workflow reads the same six complete small files and compares every byte; no truncated preview substitutes for a full read.

| Workflow | Tool calls | Median result bytes | Median local elapsed | Min–max elapsed |
| --- | ---: | ---: | ---: | ---: |
| Browser, previous raw forwarding | 6 | 67,801 | 1,160.43 ms | 1,138.89–1,164.05 ms |
| Browser, compact individual calls | 6 | 29,638 | 1,156.87 ms | 1,136.58–1,161.73 ms |
| Browser, compact batch | 1 | 10,122 | 1,166.65 ms | 1,158.22–1,169.67 ms |
| Inputs, individual reads | 6 | 5,514 | 0.812 ms | 0.694–1.517 ms |
| Inputs, grouped reads | 1 | 6,663 | 0.809 ms | 0.722–1.093 ms |

Browser batching reduced scripted tool calls by 83.3% and returned bytes by 85.1%. Compact individual browser calls reduced bytes by 56.3%. Grouped input reads reduced calls by 83.3%, while result metadata increased bytes by 20.8%. Local elapsed times did not demonstrate a speed improvement; evidence persistence adds work. Bytes measure serialized tool replies, excluding provider framing and model reasoning. Counts are scripted model-facing tool invocations, not measured model turns. **No model was called, so this benchmark does not prove lower model latency, end-to-end latency, token usage or cost.** Real model runs can require additional snapshot/detail calls, especially on larger inputs, and need separate measurement.

The raw benchmark artifact for this measurement is `runs/tool-batching-benchmark-E3B5nb/benchmark.json` in the implementation worktree. The browser/network smoke artifact is `runs/observation-smoke-gTMwrs/`.

The subsequent [30-run live GPT-6.1-Sol comparison](sol61-batching-benchmark.md) did not establish an improvement: median calls fell from 19 to 15, but median elapsed time rose from 69.20 to 80.02 seconds and result bytes from 22,991 to 42,772. Both versions also missed explicit cleanup assertion defects in the persistence case. Those measured model workflows supersede any assumption that the scripted call/byte reductions imply lower model-driven latency.
