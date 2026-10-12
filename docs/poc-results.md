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
