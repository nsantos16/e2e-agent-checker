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

## React workspace and assets

`npm run check` checks both backend and browser TypeScript. `npm test` includes workspace submission, catalog pruning, late selection responses, parallel startup, request deduplication and cancellation on unmount. API integration tests check the compiled HTML/JavaScript/CSS, asset cache headers and path boundaries. The browser suites above load the production bundle; they use no internal rendering globals.

## Stabilization evidence reuse

`npm test` checks manifest eligibility, identity changes, malformed/partial reports, missing recordings, product assertion failures, cancellation, and fallback. Run `node tests/stabilization-smoke.ts` for the real local Playwright/ffmpeg pipeline regression. It injects provider responses (no paid model calls), counts actual test-page requests, retains recordings, and prints measured execution/package times. See [qualification and compatibility](../docs/stabilization-evidence.md).
