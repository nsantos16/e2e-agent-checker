# Selectable runtimes and workspace UI

Current native account/instance management: [provider instances](provider-instances.md). Provider-only targets remain compatible; explicit `instanceId` selects a separate native profile.

Current implementation status as of 2026-11-01, including [afecea5](https://github.com/nsantos16/e2e-agent-checker/commit/afecea525e94fa1d48a37b5d722e5908df2ca943). This document describes shipped behavior and labels historical verification separately. [next-milestone.md](next-milestone.md) and [mcp-contract.md](mcp-contract.md) retain the original design baseline; [the backlog](backlog.md) separates open requests from completed work.

Live browser/network capture is described in [browser-observability.md](browser-observability.md).

## Workspace

Cases and run history live in a compact sidebar with organization, archive/restore and deletion controls. Selecting a run opens its timing, usage, evidence, recordings, demo controls and session summary in the main workspace. The bottom composer contains a searchable multi-model picker, environment/worktree selector, run options and submit button. Each selected case × model becomes a separate job. Subscription status and login instructions live in **Settings → Providers**. Settings also includes Environments, Voice narration, Sidebar, Archived and Storage. Dark/light preferences and target/worktree selection persist locally. Narrow screens use a collapsible sidebar and stacked composer/demo controls.

The design follows patterns inspected in [T3 Code](https://github.com/pingdotgg/t3code/tree/511d20c6f20c2ed6ff787aba068d7d673e2949b9): the neutral palette in `apps/web/src/index.css`, sidebar layout in `components/AppSidebarLayout.tsx`, and composer model selection in `components/chat/ProviderModelPicker.tsx` and `ModelPickerSidebar.tsx`. The current independent implementation uses [React, TypeScript and Vite](react-frontend.md).

Polling updates run summaries and evidence without replacing an existing video element. Opening a different run or a new draft intentionally closes the previous evidence view.

## Runtime support

| Runtime     | Implementation                                                                                                     | Verified locally                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex       | Native App Server, ChatGPT login, account model catalog, scoped dynamic stage tools, usage snapshots and interrupt | Full good/broken fixture pipeline, cancellation and tool configuration probes                                                                          |
| Claude Code | Native restricted CLI, subscription preflight, scoped stage MCP, streamed usage and process cancellation           | Passing live subscription fixture on 2026-11-01; fake native profiles cover account isolation and failure cases |
| Cursor      | Native auth discovery and explicit capability gate                                                                 | Installed and authenticated; worker execution remains disabled because native ACP inherits tools/MCP configuration that we could not restrict reliably |

Text-worker credentials stay in native applications. The checker does not implement a shared OAuth proxy, copy subscription credentials, silently use API keys, or silently change the requested model. The existing `@modelcontextprotocol/sdk` provides the common checker interface. ACP was researched but is not installed as an unused dependency while Cursor worker support is gated. Models and supported effort choices come from native inspection, with catalog source and limitations exposed; aliases are not assumed to identify a particular resolved version. See [provider validation](provider-instances.md#verification) for the recorded Claude/Codex live results. Optional speech uses a separate explicit API credential reference.

Claude Code, Codex and Cursor can all act as MCP callers. The caller is independent of the selected worker: a Cursor client can submit a Codex verification.

## Jobs and accounting

- Atomic batch preflight, case/model fan-out, request idempotency and persisted targets/limits.
- Queue and active duration, per-stage timing, streamed token/cache counters and completeness status. Stage metrics are snapshotted and journaled before a run finishes.
- Provider-reported dollar cost stays separate from standard API-equivalent estimates calculated with `tokentally` and a pinned LiteLLM pricing snapshot. Missing usage/model pricing stays **Unavailable**; subscription billing remains unknown. See [usage and pricing](usage-pricing.md).
- Cancellation, deadlines, partial usage preservation and process-group cleanup. Restarted active/queued jobs become `interrupted`; they are not silently rerun.
- Serialization for jobs sharing a test identity, while allowing independent identities/worktrees within configured concurrency limits.
- [Automatic saved-spec reuse](saved-spec-reuse.md) with new results and build provenance, and explicit replay without model calls. Historical exploration stays separate from current verification. [Qualified stabilization evidence](stabilization-evidence.md) can supply the final recording without a second browser execution; confirmation replay remains opt-in.
- Stable session membership, default-off narration and separate demo usage. Cache retention preserves saved outcomes and protects active verification, dependent sources and demo generation.

Generated Playwright code executes locally. Scoped tools limit what the model can request, but are not an OS sandbox for arbitrary generated test code. Use trusted projects/cases. Provider controls and tested native versions are recorded in [provider instances](provider-instances.md#verification); future CLI changes need conformance testing.

## Actual MCP surface

The shipped revision exposes 38 public tools with schemas, read/write annotations, structured results and `isError` operational errors. The [current MCP guide](agent-mcp.md#compact-defaults) lists discovery, native provider instances, case/environment management, verification, waits, diagnostics, sessions, narration and publication. Job polling is compact; logs and report bodies are requested through paged evidence calls.

`attach_to_pr` accepts exactly one job or session, a full GitHub PR URL, `publish:true`, and a silent/narrated/no-video choice. MCP and the UI use one HTTP publication service. Requests for the same source/destination serialize within that app process, and comment markers deduplicate retries; separate app processes do not share a distributed lock. No real PR publication was performed in the session-summary release checks.

## Verification evidence

At `afecea5` on 2026-11-01, `npm test` passed all 148 tests, and `npm run check` and `npm run build` passed. `node tests/demo-ui-smoke.ts` verified the real UI/API flow and responsive controls, followed by 12 playback and 82 workspace assertions. `node tests/observability-smoke.ts` and `node tests/stabilization-smoke.ts` exercised real local browser recording, retained step timing and FFmpeg packaging. Native narration text and Realtime transport used fixtures; live credentialed narration and real PR publication remain unverified. See [the test guide](../tests/README.md) for repeatable commands.

Real local Kokoro, Piper and Chatterbox Nano synthesis was measured separately. Those [voice samples](research/local-voice-samples.md) use a labeled synthetic script and are not browser verification evidence or integrated app providers.

### Historical baseline: 2026-10-12

`npm test`: 11 passing tests for token normalization, partial usage/cancellation, timeouts, scoped tool paths, real stabilization exit codes, attempts limits, job recovery/idempotency MCP contracts and network diagnostics. `npm run check`: passing. Browser checks: 12 playback assertions and 24 workspace assertions, using the actual HTML with isolated API fixtures. Desktop dark and mobile light layouts were inspected through the T3 browser recording tool; the snapshot tool failed in this session. A real saved recording advanced from 10.66s to 17.16s across polling while retaining the same player node.

Live Codex runs used `gpt-6.1-sol` and a disposable local multiline-note page. They consumed the existing ChatGPT allowance. IDs below are local `runs/` directories, intentionally excluded from Git.

| Fixture               | Run                                               | Explore / codify / replay          | Tokens  | Model-stage wall time |
| --------------------- | ------------------------------------------------- | ---------------------------------- | ------- | --------------------- |
| Good                  | `20261012T212833-SMOKE-999999-slot999-good-c23`   | pass / passed / passed             | 155,915 | 23.557s + 35.874s     |
| Broken (newline lost) | `20261012T212957-SMOKE-999999-slot999-broken-1pf` | fail / failed-as-expected / failed | 146,826 | 26.486s + 51.782s     |

Both produced replay MP4s and one stabilization attempt. These timings exclude setup, replay and packaging. Live smoke preceded the final result-hash validation and UI refinements; the final local tests cover the recorded attempt/hash data and UI behavior. Native cancellation stopped a waiting tool run in approximately 4.2 seconds; usage before the first provider event remains unknown.

The real Sample run `job-1586d88c-ee0f-44b6-a60e-7213df121994` / `DEMO-6003` was **blocked** by an expired browser session. The 1Password authorization prompt for refreshing it was dismissed. This historical run is not evidence of a passing live Sample regression or cross-provider parity. Later native fixture results are recorded separately in [provider validation](provider-instances.md#verification).

## Remaining work

1. Refresh the Sample test-user session and rerun the real known-good/known-broken pair; local provider fixtures do not establish a passing Sample regression.
2. Implement Cursor execution only after verified tool isolation, or an explicitly designed process sandbox, is available.
3. Extend the standard API pricing estimates with verified service-tier/context-tier pricing where runtimes expose the required metadata.
4. Extend fixture leases/reset checks. Case/build provenance, instance identity and native usage-limit handling are already implemented; their limits are documented in the respective guides.
5. Add durable event cursors and resumable stages; current restart behavior deliberately terminates interrupted jobs.
6. Verify live credentialed narration and publication to a separately authorized PR destination. Local protocol/publication fixtures cover these paths without making real calls.

## Sessions and optional voice demos

[Session summaries and voice demos](session-demos.md) documents explicit membership, shared API/MCP/UI settings, generation without publication, bounded narration, content caches and separate usage. Summaries require no model calls. Narration defaults off; installing the feature, finishing a run or opening a summary cannot start paid audio generation. Open-source engines have local comparison samples but remain future provider options.
