# Regression checks

## Saved-spec reuse

`npm test` includes saved-spec manifest decisions and pipeline/queue regressions. `node tests/saved-specs-smoke.ts` adds real Playwright verification against disposable localhost builds, including a preserved regression and fresh video/trace/network evidence. It calls no model providers and writes measured replay durations to its printed `measurements.json`. See [behavior and measurement limits](../docs/saved-spec-reuse.md).

## App playback regression

Start `npm run app`, then evaluate the contents of `app-playback.browser.js` in the app's browser context with `preview_evaluate`, or paste the file into the browser's developer console.

The check loads the current app UI in an isolated frame, mocks the APIs, and manually triggers polling timers. It does not start test jobs or require existing recordings. Success returns `{ passed: 12, checks: [...] }`; a regression returns `{ failed: "...", passed: ... }`.

It exercises the built React components through real controls and fixture API responses to check that polling, progress updates, expansion of another run, metadata and evidence updates, and arrival of new runs preserve the mounted player and its settings. It also checks that collapsing and removing runs still work. Actual media playback should additionally be checked on an existing recording across several polling intervals.

## Workspace regression

Evaluate `app-workspace.browser.js` the same way. Success returns 64 checks covering automatic reuse/fresh authoring, case selection, catalog refresh and draft activation, multi-model batch submission, model search, keyboard focus, unavailable-provider guidance, separate Connections settings, focused run history, polling, new drafts, theme persistence mobile layout, side-panel docking and browser preservation, network search/type/stage filters, sorting, response/raw detail, copy actions, keyboard navigation, pause/resume, bounded loading, retention disclosure, responsive inspection, escaped response text, live frame identity, closed-session labeling and direct selection of older runs. Requests, preferences and polling are mocked inside an isolated frame; this test does not consume subscription allowance or start real jobs.

## Browser/network runtime smoke

Run `node tests/observability-smoke.ts` after browser setup. This uses the real checker Playwright MCP and replay pipeline against a disposable localhost page, with no model calls. It checks live frames, HTTP 503 and transport failures, request IDs, redaction, automatic agent-tool context, and capture through stabilization and replay. Evidence remains in the printed gitignored `runs/observation-smoke-*` directory.

## Agent MCP contract and API integration

`npm test` includes real stdio MCP client tests against a controlled HTTP fixture and a separate local app with disposable job/artifact state. They cover all 25 tool schemas, tool annotations, batch waiting and revisions, failure summaries, case search/read, bounded network and artifact pages, canonical artifact boundaries, and on-demand image delivery with unchanged-frame suppression. They do not launch model calls or publish evidence.

## Environment login smoke

Run `node tests/environment-login-smoke.ts` to test the actual credential-reference and login harness against two disposable localhost targets. It uses dummy credentials, checks separate sessions and owner-only file permissions, and cleans up its session files. It makes no model or 1Password calls. Workspace browser checks cover environment settings, users, hosted/local selection and mobile layout.

Pricing tests use fixed catalogs to verify cache/read/write arithmetic, reasoning subsets, mixed-model attribution, missing rates, pinned snapshots, and cancellation. API/MCP tests check on-demand pricing/usage evidence. No paid model calls are made.

## Browser navigation readiness

Run `npm run test:readiness` after browser setup. The Playwright suite exercises the real `openPage` helper against a disposable localhost HTTP server. It covers continuous background requests, delayed UI state and loading-indicator mounting, multiple spinners, pages that never become ready, successful and failed cold-link recovery, wrong destinations, intentional redirects, origin checks, HTTP/transport errors, selector errors, and closed pages. Servers and browser contexts are disposed after the run; no application credentials, external data, or model calls are used.

Run `READINESS_BENCHMARK=1 npm run test:readiness` to also measure the old and new helpers on the same four fixture scenarios. The frozen baseline is `openPage` from `ba15ae4`, with its original 30-second network-idle and 25-second spinner timeouts. Both implementations use fresh contexts in the same Chromium run with no slow motion, tracing on failure only, and identical fixture timing. The new helper uses its production 15-second budget, not the shorter budgets used by individual failure tests. Timing includes the old helper's unconditional home visit and any recovery. The comparison deliberately distinguishes returning early from being ready and records recovery counts and document requests.

The JSON report is `runs/readiness/report.json`; its benchmark attachment contains `readiness-timings.json`. These are fixture measurements, not application-wide performance claims. See [readiness behavior and measured results](../docs/browser-readiness.md).

## Effect runtime regression

`npm test` includes `effect-runtime.test.ts`: process-group cleanup on cancellation, scoped release before timeout errors, sibling cancellation during credential resolution, failed Codex initialization, cancelled browser MCP initialization, and a verification using injected provider/process/pricing services. Job tests also cover shutdown of active and queued work and a submission racing shutdown. Run `npm run check` for service dependency and effect type checking. The localhost smoke tests above exercise real browser resources through the same scoped runtime.

## Stage batching and result limits

`npm test` also includes `stage-tools.test.ts` and `stage-adapters.test.ts`: ordered browser calls, uncertain mutations, queued/active cancellation, complete action history, compact output, bounded text/image retrieval, input-file boundaries, credential redaction and both provider protocols. `node tests/tool-batching-benchmark.ts` compares raw browser forwarding, compact individual calls and known sequences in the existing Playwright code tool, plus individual/grouped full input reads. Its real-browser negative control verifies that a thrown assertion prevents a subsequent save. It uses localhost fixtures, makes no model calls and writes measurements under `runs/`. See [the tool contract and measured results](../docs/tool-batching.md).

### Live GPT-6.1-Sol comparison

`node tests/model-batching-benchmark.ts --baseline /absolute/path/to/original-worktree` runs real subscription model calls. It is intentionally excluded from `npm test`. Use a separate baseline checkout with the original code, prompts and installed dependencies. Both worktrees must be configured for Chromium and replay. `--pilot` runs one pair per workflow outside the measured experiment; the default runs three workflows, five paired repetitions each (30 complete explore → codify → replay workflows), at medium reasoning and standard service tier. `--resume /absolute/path/to/run` retains completed rows and checks that source hashes match; do not alter the tested implementation during a measured experiment.

The model chooses its tools freely in both versions, including the existing browser code-execution capability. Each run has a fresh browser context, a ten-minute workflow deadline, at most 80 tool calls per stage and two stabilization attempts. Paired order alternates and workflow pairs are shuffled with a fixed seed. Artifacts under the printed `runs/sol61-model-benchmark-*` directory include the plan, source hashes, prompts, transcripts, tool replies, token usage, timing, exploration observations, generated-test replay and independent mutation-audit results.

Quality requires exact exploration verdicts, observed state and cleanup, matching stabilization/replay outcomes, and every generated assertion catching its corresponding injected defect. The deliberate persistence bug also has a repaired control that must pass. Failed runs remain in the results and receive the predeclared ten-minute cap when scoring time to a correct result. Assertion audits run after the timed workflow. The acceptance target is at least 15% median paired improvement, a positive lower bound on a stratified paired bootstrap 95% interval, and all candidate runs meeting the quality checks. Tool calls and reply bytes are measured separately; provider time minus tool time still includes orchestration and transport, so it is not pure model inference latency.

The [initial GPT-6.1-Sol report](../docs/sol61-batching-benchmark.md) preserves the negative result. The [revision report](../docs/sol61-batching-revision-benchmark.md) records the fixes and a new frozen 30-run comparison, including byte overhead, uncertainty in paired elapsed time and the retained audit setup failure. A resumed interrupted workflow is retained as a failure rather than automatically rerun.

The [component comparison](../docs/sol61-batch-ablation.md) then compared the revised implementation with and without generic `browser_batch`, selecting the simpler interface. To reproduce it, use `--ablation --baseline /absolute/path/to/frozen-full-worktree`; that checkout must still expose the generic tool. Both arms use that same implementation, and the control removes only its batch interface/guidance. Mutation audits use one worker in both arms, with unchanged assertions, timeouts and no retries. All 30 workflows and 310 assertion/control checks qualified; the added tool did not meet the predeclared performance target. The final implementation uses existing browser code execution and retains grouped reads and safety/evidence behavior.

## React workspace and assets

`npm run check` checks both backend and browser TypeScript. `npm test` includes workspace submission, catalog pruning, late selection responses, parallel startup, request deduplication and cancellation on unmount. API integration tests check the compiled HTML/JavaScript/CSS, asset cache headers and path boundaries. The browser suites above load the production bundle; they use no internal rendering globals.

## Stabilization evidence reuse

`npm test` checks manifest eligibility, identity changes, malformed/partial reports, missing recordings, product assertion failures, cancellation, and fallback. Run `node tests/stabilization-smoke.ts` for the real local Playwright/ffmpeg pipeline regression. It injects provider responses (no paid model calls), counts actual test-page requests, retains recordings, and prints measured execution/package times. See [qualification and compatibility](../docs/stabilization-evidence.md).
