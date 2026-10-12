# PoC results log

## It-1: one case, one worktree, by hand (2026-10-12)

**Setup:**
- Slot 1 is the frontend worktree `~/work/sample-frontend-e2e-slot1`, detached at `master` `199c27023c`, with `node_modules` symlinked. It runs `vp dev --mode ci.development --port 4001` against the dev API ([ADR-0003](adr/0003-frontend-worktrees-against-shared-dev-backend.md)).
- Login is `src/login.ts`, as role `eugene` (1Password `Engineering Shared`, read through the `op` CLI fallback). It saves `storageState` with IndexedDB to `.state/slot1-eugene.json`.
- The agent is `claude -p` with Playwright MCP 0.0.83 only (`src/run-case.ts`). It records video with `contextOptions.recordVideo`. Prompt: `prompts/verify-case.md`.

### DEMO-3949: Comment search, no-results state

| Run | Model | Verdict | Cost | Turns / tool calls | Wall | Video |
|---|---|---|---|---|---|---|
| 1 | default (Fable 5.1) | blocked: MCP's Chromium build wasn't installed | $0.64 | 5 / 4 | 22 s | none |
| 2 | default (Fable 5.1) | **fail** (step 3) | $2.25 | 41 / 40 | 185 s | 11 MB webm |
| 3 | Sonnet 5.5 | **fail** (step 3) | **$0.30** | 35 / 34 | 68 s | webm |

**Verdict check (ground truth from source):** `src/features/Comments/Feed/ChatFeed.tsx:212` renders `{searchResultsCount} results for “{searchTerm}“`.
- **The case is stale.** The app says "0 results for", but the case expects "no results for". Qase DEMO-3949 needs updating.
- **Real minor bug:** the closing quote is U+201C (`“`) instead of U+201D (`”`). Run 2 caught this.
- Both runs gave the correct verdict, with accurate evidence and no data changes.

Extra observations the agent reported:
- The notification bell button has no `aria-label` or `data-testid`, which makes it hard to locate. This is an accessibility and testability gap.
- Search only applies on Enter or after a debounce.
- Console errors jumped from ~5 to ~200 after submitting the search. Not yet investigated.

### Learnings

1. **A wrong environment produces `blocked`, not a false `pass`.** Run 1 shows the blocked/fail distinction in the prompt works.
2. **Navigation is where the turns go.** "Navigate to the Comments section" gives no route, and the case's preconditions are just links to other Qase cases. Most of the turns were spent exploring the nav. To fix this, resolve the linked Qase cases into the prompt and add a small app map (routes, plus where the main features live).
3. **Model choice matters more than the driver.** Sonnet 5.5 was 7.5× cheaper and 2.7× faster than the default (Fable 5.1), with the same verdict. Default to Sonnet for explore runs.
4. **Cache reads dominate the token count** (1.8M cache-read tokens in run 2). Each turn re-sends the whole context. This matches the benchmark finding that turns drive cost.
5. **Video:** an 11 MB webm for 3 minutes of exploration is close to the 10 MB GitHub free-plan limit, and it's long to watch. This supports replaying a codified spec for the PR video (It-2). `ffmpeg` isn't installed yet, and It-2 needs it for webm→mp4.
6. **1Password SDK desktop auth** fails with `IPC operation failed: -3`, probably because "Integrate with other apps" is off in the 1Password app. The `op read` fallback works.
7. **TOTP:** the `eugene` item has an OTP field, but login didn't ask for a code. Firebase MFA isn't enrolled for this user, or isn't required.

## It-1 (continued): all cases, app map, regression pair

Two changes cut cost and stopped the agent getting lost:
- An **app map** (`context/sample-app.md`): routes from `routeTree.gen.ts`, UI landmarks from the suite's page objects, and role-specific test data.
- **Linked Qase cases** resolved into the prompt.

**Test data finding:** the suite's dev labels (clients 8244/14352/7023) belong to the CI user. `eugene@example.com` gets a 401 on them, and the app shows that as "session expired". Eugene's practice (56 clients, working client 5670) is now in the app map.

| Case | Verdict | Ground truth | Correct? |
|---|---|---|---|
| 3949 comment search no-results | fail (step 3), 4/4 runs | `ChatFeed.tsx:212` says "0 results for “…“": the case is stale, plus a wrong closing quote | ✅ |
| 2359 add comment | pass | — | ✅ |
| 6003 Shift+Enter list item, **master** | pass, 3/3 runs | WMD-1920 fixed | ✅ |
| 6003 Shift+Enter list item, **pre-fix `04515988f4`** | **fail (step 5)**, 3/3 runs | WMD-1920 bug present | ✅ |
| 6004 single-line lists (control) | pass | should pass on both builds | ✅ |
| 6912 archive/unarchive client | blocked | needs a disposable client, and creating one needs a QBO/Xero connection | ✅ correctly blocked |
| 6914 status filter | pass | — | ✅ |
| 6915 Task Name filter | pass | backend fix `42a3e624c4` is deployed on dev | ✅ |
| 6049 limited-access user | blocked | needs a second, limited test user | ✅ correctly blocked |
| 6611 Internal tab | fail (step 1) | `useInternalCapabilities` ("for the nav tab") has no consumer on master, so no tab is rendered | ✅ |
| 6614 Ledger Inspector URL filters | pass | — | ✅ (not independently verified) |

**Q1: 11/11 verdicts consistent with ground truth** where ground truth is checkable, with zero false passes. Repeats were stable: 3949 ×4, and 6003 ×3 on each build.

## It-2/It-3: Explore → Codify → Replay

| Case | Explore | Codify (attempts) | Replay | Failed at | MP4 | Replay time | Explore + codify cost |
|---|---|---|---|---|---|---|---|
| 2359 | pass | passed (3) | passed | — | 0.91 MB | 80 s | $0.48 |
| 3949 | fail | failed-as-expected (1) | failed | Step 3 | 0.88 MB | 83 s | $0.49 |
| 6003 (master spec) | pass | passed (6) | **master passed / pre-fix failed** | Step 5 on pre-fix | 1.6 MB / 1.8 MB | ~135 s | $0.45 |
| 6004 | pass | passed (1) | passed | — | 1.49 MB | 112 s | $0.47 |
| 6611 | fail | failed-as-expected (1) | failed | Step 1 | 0.75 MB | 82 s | $0.33 |
| 6614 | pass | passed (3) | passed | — | 0.43 MB | 232 s | $0.53 |
| 6914 | pass | passed (1) | passed | — | 0.70 MB | 70 s | $0.30 |
| 6915 | pass | passed (2) | passed | — | 0.82 MB | 75 s | $0.53 |

- **Every replay matches its explore verdict**, and failing specs fail at the same step on the expected-result assertion.
- The **6003 spec is a real regression test.** Generated from the master exploration, it passes on master and fails at step 5 on the pre-fix build.
- **Q2: videos are 0.4–1.8 MB MP4s** (H.264, 1280 wide), far under GitHub's 10 MB limit, with a caption for each Qase step.
- **Q4 cost:** about $0.30–$0.55 per case for explore and codify, done once. Re-verifying with the spec costs **$0** and takes ~1–4 min. The total spend for the whole PoC (31 agent runs, including early Fable runs and failed experiments) was **$9.83**.

Problems found and fixed on the way:
1. **Codify cleanup failures masked passing tests.** `cleanup()` is now best-effort and recorded as an annotation, plus there's a sweeper (`e2e/sweep`) for leftovers.
2. **Cold deep links stall old builds** on the app spinner. `openPage()` now warms the app from `/client-list` and waits for network idle before checking the spinner. Before this, the "spinner hidden" check passed before the spinner had even mounted.
3. **Child agents inherited the user's permission mode.** The codify agent ran arbitrary shell commands despite `--allowedTools`. All child agents now run `--restricted --permission-mode dontAsk`, which I verified: an arbitrary write is denied. As a side effect explore got cheaper ($0.11 / 14 turns for 3949).

## It-4: parallel worktrees

- `src/slots.ts` serves each worktree on `4000 + slot`, detached, with a health check, and warms Vite's dependency optimisation.
- Up to **4 agents ran concurrently** across slots 1–4: two batch workers plus the repeats on master and pre-fix. Each slot had its own origin and session, with the same test user. No interference was observed. Agents saw each other's `e2e-agent-*` notes and left them alone.
- A worktree whose `yarn.lock` differs from the main checkout needs its own install. The pre-fix worktree needed `yarn install --ignore-engines --ignore-scripts`: Node 26.7 vs a 26.4 engine pin, and the optional `canvas` build fails.
- **Not done:** backend worktrees through `yarn local-workspace` (needs the dev SSH tunnel), so the backend regression pair for 6915 wasn't run. Pool users (`e2eworker02..05`) weren't wired up because their shared password isn't in a 1Password item we found.

## It-5: MCP

- `src/mcp-server.ts` exposes `verify_case`, `get_job`, `list_jobs`, `list_slots` and `attach_to_pr`.
- **End-to-end test through a real MCP client:** `verify_case` on a brand-new worktree. The server allocated slot 4, symlinked `node_modules`, started the dev server, logged in, then explored, codified (3 attempts) and replayed: **pass**, 0.9 MB MP4, 10 min, **$0.60**.
- `attach_to_pr` (`gh pr comment --body-file --attach`, gh 2.102) is implemented but **not exercised**. It publishes to GitHub, where attachments are public by URL, so it waits for an explicit go-ahead and a target PR.

## Open items / next steps

1. Publish one PR comment with `attach_to_pr` once a target PR is chosen. That's the last part of Q2.
2. Fixtures for blocked cases: a dedicated archivable client and a limited-access user (in 1Password) for 6912 and 6049.
3. Wire up the pool users, one per slot, for real data isolation in parallel runs (ADR-0003).
4. Backend worktrees through `local-workspace` for backend regression pairs (6915).
5. Contribute generated specs back to `sample-frontend/tests/e2e`. They already follow the suite's locator conventions but use standalone fixtures.
6. Feed agent findings back into Qase: 3949 is stale, 6611 doesn't match master.
