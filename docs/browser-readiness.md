# Browser navigation readiness

`openPage` in `e2e/qase-step.ts` navigates directly to the requested destination using `domcontentloaded`. It then checks the destination URL, positive readiness locators, and relevant loading indicators together. Navigation and readiness share a bounded budget of 15 seconds per attempt. Background requests are not part of the readiness condition.

```ts
await openPage(page, '/reports', {
  ready: [page.getByTestId('report-loaded'), page.getByRole('button', { name: 'Export' })],
  loading: page.locator('[data-testid="report-region"][aria-busy="true"]'),
  recovery: false,
});
```

`ready` accepts a locator or an array of locators; every locator must be visible. Use loaded data, a confirmed empty state, a control that becomes usable after initialization, or state-bearing attributes. For example, use `button:enabled` when enabled state is required. A heading or shared navigation shell alone is not sufficient. `loading` accepts the same shape and checks **all** visible matches on every poll, including indicators that mount after navigation. It cannot compensate for a positive marker that incorrectly claims readiness before the application's work begins. Existing case assertions remain separate from readiness.

By default the pathname and origin must match. Search parameters can normalize without blocking readiness; assertions should still check any query state required by the case. Supply `matchesURL: (url) => ...` for intentional same-origin redirects. Cross-origin redirects, HTTP errors, transport failures, invalid selectors, and page closure are not repaired by navigation recovery.

Compatibility profiles cover the client list, client landing page, notes list, Bank Feeds/Bank Feeds Next, firm tasks, and the Ledger Inspector list (including its legacy alias). The client landing profile accepts the same client's close/tax redirect; the list profiles accept loaded rows or appropriate empty states. Their selectors come from the inspected Sample frontend source. Other destinations fail with an instruction to supply `ready`; saved specs using unsupported routes need those locators added. The legacy third-argument home URL is still accepted, but its destination must also have a readiness profile.

The default recovery is a single home visit to `/client-list`, followed by a retry of the original URL. It happens only after a failed cold readiness check with a visible loading spinner at the expected destination, or a redirect to the home route. A successful navigation marks the page warm. Later failures, login redirects, failures without cold-navigation evidence, and repeated recovery attempts propagate. Configure another home with `recovery: { url, ready, loading }`, or disable recovery with `recovery: false`. Each recovery leg has the same bounded budget, so a failed initial attempt plus home and destination attempts can consume up to three budgets. An `app-recovery` annotation records the initial failure, attempted recovery and outcome; failed recovery retains both errors.

The checked-in notes example now asserts the saved row after navigation without a broad retry around both. The sweep waits for the notes table's readiness, allowing an empty list without an ignored row timeout. Case assertions and cleanup semantics are preserved. The generation prompt requires positive readiness and prohibits global network-idle waits and swallowed readiness errors. Existing generated files are not rewritten automatically.

## Fixture measurements

Run `READINESS_BENCHMARK=1 npm run test:readiness` to reproduce the comparison. It uses the unmodified helper algorithm from `ba15ae4` as the baseline and identical disposable HTTP fixtures, fresh browser contexts, one Chromium worker, no slow motion, and the production timeout defaults. Measurements include all helper navigation and recovery work, but exclude context creation and verification after return.

Final run on 2026-10-26; one sample per implementation/scenario (an earlier full comparison gave the same outcomes):

| Fixture | Before | After | Result |
| --- | ---: | ---: | --- |
| Continuous background requests; content ready | 60.071 s | 0.024 s | Both ready; the new helper visits only the target |
| UI state and spinner mount late | 1.038 s | 1.887 s | Old helper returned before readiness; new helper waited for ready state and spinner removal |
| Never ready, no spinner | 1.035 s | 15.011 s | Old helper returned incorrectly; new helper failed with missing-element diagnostics |
| Cold deep link stalls until home is visited | 1.034 s | 15.025 s | Both ready; new helper first observed failure and recorded one recovery |

The delayed fixture mounts its spinner at 900 ms, marks data ready at 1,400 ms, and removes the spinner at 1,800 ms after destination navigation. The old helper returns around 500 ms into that destination, before the indicator mounts. The polling fixture sends overlapping requests every 100 ms on both the home and destination pages, exercising both former 30-second waits.

These results establish correctness and timing on these fixtures only. They do not measure application-wide speedups, production latency, slow development builds, or every saved replay. The recovery fixture is slower because unconditional warming has been removed; the default waits for a 15-second failure before warming. Destination markers and timeout budgets may need adjustment for other builds, and a full test must budget for recovery if it is enabled.

Validation: `npm test` passed 29 tests; `npm run check` passed both TypeScript checks; `READINESS_BENCHMARK=1 npm run test:readiness` passed 21 browser checks including the comparison. `git diff --check` and formatting checks on the helper and new TypeScript fixtures passed.
