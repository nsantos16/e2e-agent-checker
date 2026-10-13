# Selectable runtimes and workspace UI

Implemented and checked on 2026-10-12. This document describes the shipped scope; [next-milestone.md](next-milestone.md) and [mcp-contract.md](mcp-contract.md) retain the broader design baseline.

Live browser/network capture is described in [browser-observability.md](browser-observability.md).

## Workspace

Cases and run history live in a compact sidebar. Selecting a run opens its timing, usage, evidence and recording in the main workspace. The bottom composer contains a searchable multi-model picker, worktree selector, run options and submit button. Each selected case × model becomes a separate job. Subscription status and login instructions live in **Connections**, accessed from the sidebar footer. Dark/light preferences and target/worktree selection persist locally. Narrow screens use a collapsible sidebar and a two-row composer.

The design follows patterns inspected in [T3 Code](https://github.com/pingdotgg/t3code/tree/511d20c6f20c2ed6ff787aba068d7d673e2949b9): the neutral palette in `apps/web/src/index.css`, sidebar layout in `components/AppSidebarLayout.tsx`, and composer model selection in `components/chat/ProviderModelPicker.tsx` and `ModelPickerSidebar.tsx`. This is an independent HTML/CSS implementation using those layout patterns.

Polling updates run summaries and evidence without replacing an existing video element. Opening a different run or a new draft intentionally closes the previous evidence view.

## Runtime support

| Runtime     | Implementation                                                                                                     | Verified locally                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex       | Native App Server, ChatGPT login, account model catalog, scoped dynamic stage tools, usage snapshots and interrupt | Full good/broken fixture pipeline, cancellation and tool configuration probes                                                                          |
| Claude Code | Native restricted CLI, subscription preflight, scoped stage MCP, streamed usage and process cancellation           | Mocked stream/cancellation tests. Local CLI uses an API key, so live subscription execution is blocked with `AUTH_MODE_MISMATCH`                       |
| Cursor      | Native auth discovery and explicit capability gate                                                                 | Installed and authenticated; worker execution remains disabled because native ACP inherits tools/MCP configuration that we could not restrict reliably |

Credentials stay in native applications. The checker does not implement a shared OAuth proxy, copy subscription credentials, silently use API keys, or silently change the requested model. The existing `@modelcontextprotocol/sdk` provides the common checker interface. ACP was researched but is not installed as an unused dependency while Cursor worker support is gated. Claude's model list currently uses native aliases (`sonnet`, `opus`, `haiku`), not a live entitlement catalog.

Claude Code, Codex and Cursor can all act as MCP callers. The caller is independent of the selected worker: a Cursor client can submit a Codex verification.

## Jobs and accounting

- Atomic batch preflight, case/model fan-out, request idempotency and persisted targets/limits.
- Queue and active duration, per-stage timing, streamed token/cache counters and completeness status. Stage metrics are snapshotted and journaled before a run finishes.
- Provider-reported dollar cost stays separate from standard API-equivalent estimates calculated with `tokentally` and a pinned LiteLLM pricing snapshot. Missing usage/model pricing stays **Unavailable**; subscription billing remains unknown. See [usage and pricing](usage-pricing.md).
- Cancellation, deadlines, partial usage preservation and process-group cleanup. Restarted active/queued jobs become `interrupted`; they are not silently rerun.
- Global serialization for jobs sharing a test role, while allowing different roles/worktrees within configured concurrency limits.
- Replay of a saved spec without new model calls. Reports are validated against expected steps; a stabilized result must match the last actual test attempt and unchanged spec hash.

Generated Playwright code executes locally. Scoped tools limit what the model can request, but are not an OS sandbox for arbitrary generated test code. Use trusted projects/cases. Current Codex controls were checked against CLI 0.162.1; future CLI changes need conformance testing.

## Actual MCP surface

All 12 tools advertise input/output schemas and return `structuredContent.data`; operational errors use `isError`.

| Tools                                 | Current behavior                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `list_providers`, `list_models`       | Native readiness/auth mode, login instructions and available model IDs                                           |
| `list_cases`, `list_worktrees`        | Imported cases and discovered frontend worktrees                                                                 |
| `verify_case`, `verify_cases`         | Background job ID(s), explicit subscription targets, limits and optional idempotency key                         |
| `get_job`, `list_jobs`, `get_network` | Bounded logs, usage/timing and evidence; job listing supports status/provider/batch filters and an offset cursor |
| `cancel_job`, `replay_job`            | Idempotent cancellation; new replay job on the original worktree                                                 |
| `attach_to_pr`                        | Requires a full GitHub PR URL and `publish: true`; checks a job marker before posting                            |

The marker prevents ordinary sequential duplicate publication; it is not a distributed lock across concurrent MCP processes. Publishing was not exercised against a real PR in this milestone.

## Verification evidence

`npm test`: 11 passing tests for token normalization, partial usage/cancellation, timeouts, scoped tool paths, real stabilization exit codes, attempts limits, job recovery/idempotency MCP contracts and network diagnostics. `npm run check`: passing. Browser checks: 12 playback assertions and 24 workspace assertions, using the actual HTML with isolated API fixtures. Desktop dark and mobile light layouts were inspected through the T3 browser recording tool; the snapshot tool failed in this session. A real saved recording advanced from 10.66s to 17.16s across polling while retaining the same player node.

Live Codex runs used `gpt-6.1-sol` and a disposable local multiline-note page. They consumed the existing ChatGPT allowance. IDs below are local `runs/` directories, intentionally excluded from Git.

| Fixture               | Run                                               | Explore / codify / replay          | Tokens  | Model-stage wall time |
| --------------------- | ------------------------------------------------- | ---------------------------------- | ------- | --------------------- |
| Good                  | `20261012T212833-SMOKE-999999-slot999-good-c23`   | pass / passed / passed             | 155,915 | 23.557s + 35.874s     |
| Broken (newline lost) | `20261012T212957-SMOKE-999999-slot999-broken-1pf` | fail / failed-as-expected / failed | 146,826 | 26.486s + 51.782s     |

Both produced replay MP4s and one stabilization attempt. These timings exclude setup, replay and packaging. Live smoke preceded the final result-hash validation and UI refinements; the final local tests cover the recorded attempt/hash data and UI behavior. Native cancellation stopped a waiting tool run in approximately 4.2 seconds; usage before the first provider event remains unknown.

The real Sample run `job-1586d88c-ee0f-44b6-a60e-7213df121994` / `DEMO-6003` was **blocked** by an expired browser session. The 1Password authorization prompt for refreshing it was dismissed. This is not evidence of a passing live Sample regression, and Claude/Cursor cross-provider parity is not claimed.

## Remaining work

1. Refresh the Sample test-user session and rerun the real known-good/known-broken pair. Validate Claude after native subscription login.
2. Implement Cursor execution only after verified tool isolation, or an explicitly designed process sandbox, is available.
3. Extend the standard API pricing estimates with verified service-tier/context-tier pricing where runtimes expose the required metadata.
4. Freeze case/worktree fingerprints, add fixture leases/reset checks and provider-specific rate-limit handling.
5. Add durable event cursors and resumable stages; current restart behavior deliberately terminates interrupted jobs.
6. Exercise authorized PR publication and coordinate concurrent publication attempts.

## Agent MCP v0.4

See [the implemented agent workflow](agent-mcp.md) for compact status, searchable discovery, setup/case tools, batch waits, bounded evidence and network reads, browser frames, and viewer links. The server now exposes 18 tools. These are local stdio capabilities; native login and the Cursor worker gate are unchanged.
