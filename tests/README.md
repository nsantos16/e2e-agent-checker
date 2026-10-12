# App playback regression

Start `npm run app`, then evaluate the contents of `app-playback.browser.js` in the app's browser context with `preview_evaluate`, or paste the file into the browser's developer console.

The check loads the current app UI in an isolated frame, mocks the APIs, and disables polling timers. It does not start test jobs or require existing recordings. Success returns `{ passed: 12, checks: [...] }`; a regression returns `{ failed: "...", passed: ... }`.

It exercises the real rendering and refresh functions to check that polling, progress updates, expansion of another run, metadata and evidence updates, and arrival of new runs preserve the mounted player and its settings. It also checks that collapsing and removing runs still work. Actual media playback should additionally be checked on an existing recording across several polling intervals.

## Workspace regression

Evaluate `app-workspace.browser.js` the same way. Success returns 16 checks covering case selection, multi-model batch submission, model search, keyboard focus, unavailable-provider guidance, separate Connections settings, focused run history, polling, new drafts, theme persistence and mobile layout. Requests, preferences and polling are mocked inside an isolated frame; this test does not consume subscription allowance or start real jobs.
