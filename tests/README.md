# App playback regression

Start `npm run app`, then evaluate the contents of `app-playback.browser.js` in the app's browser context with `preview_evaluate`, or paste the file into the browser's developer console.

The check loads the current app UI in an isolated frame, mocks the APIs, and disables polling timers. It does not start test jobs or require existing recordings. Success returns `{ passed: 12, checks: [...] }`; a regression returns `{ failed: "...", passed: ... }`.

It exercises the real rendering and refresh functions to check that polling, progress updates, expansion of another run, metadata and evidence updates, and arrival of new runs preserve the mounted player and its settings. It also checks that collapsing and removing runs still work. Actual media playback should additionally be checked on an existing recording across several polling intervals.
