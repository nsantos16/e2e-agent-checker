# App playback regression

Start `npm run app`, then evaluate the contents of `app-playback.browser.js` in the app's browser context with `preview_evaluate`, or paste the file into the browser's developer console.

The check loads the current app UI in an isolated frame, mocks the APIs, and disables polling timers. It does not start test jobs or require existing recordings. Success returns `{ passed: 12, checks: [...] }`; a regression returns `{ failed: "...", passed: ... }`.

It exercises the real rendering and refresh functions to check that polling, progress updates, expansion of another run, metadata and evidence updates, and arrival of new runs preserve the mounted player and its settings. It also checks that collapsing and removing runs still work. Actual media playback should additionally be checked on an existing recording across several polling intervals.

## Workspace regression

Evaluate `app-workspace.browser.js` the same way. Success returns 51 checks covering case selection, catalog refresh and draft activation, multi-model batch submission, model search, keyboard focus, unavailable-provider guidance, separate Connections settings, focused run history, polling, new drafts, theme persistence mobile layout, side-panel docking and browser preservation, network search/type/stage filters, sorting, response/raw detail, copy actions, keyboard navigation, pause/resume, bounded loading, retention disclosure, responsive inspection, escaped response text, live frame identity, closed-session labeling and direct selection of older runs. Requests, preferences and polling are mocked inside an isolated frame; this test does not consume subscription allowance or start real jobs.

## Browser/network runtime smoke

Run `node tests/observability-smoke.ts` after browser setup. This uses the real checker Playwright MCP and replay pipeline against a disposable localhost page, with no model calls. It checks live frames, HTTP 503 and transport failures, request IDs, redaction, automatic agent-tool context, and capture through stabilization and replay. Evidence remains in the printed gitignored `runs/observation-smoke-*` directory.

## Agent MCP contract and API integration

`npm test` includes real stdio MCP client tests against a controlled HTTP fixture and a separate local app with disposable job/artifact state. They cover all 22 tool schemas, tool annotations, batch waiting and revisions, failure summaries, case search/read, bounded network and artifact pages, canonical artifact boundaries, and on-demand image delivery with unchanged-frame suppression. They do not launch model calls or publish evidence.
