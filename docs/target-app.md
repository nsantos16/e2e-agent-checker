# Target app: Sample (sample-frontend / sample-backend)

Status: findings · 2026-10-12 · Local clones: `~/work/sample-frontend`, `~/work/sample-backend`

## Environments

| Name people use | Frontend | API | Playwright project |
|---|---|---|---|
| **"staging" = development** (deploys from the `staging` branch, which auto-syncs from `master`) | `https://staging.example.com` | `https://usa-serv.example-api.com` | `Development`, `CI` |
| local | `http://localhost:3000` | `http://localhost:9000`, or dev API | `Local` |
| per-branch preview | `https://<branch>.preview.example.com` | `https://<branch>.api-preview.example.com` | `Preview` |
| legacy "Staging" | `https://former-staging.example.app` | — | `Staging` |

## Facts that shape the PoC

**Running the frontend against the shared dev backend works with no backend running locally.**
- `yarn staging --port <N> --strictPort` uses `.env.ci.development` (API `usa-serv.example-api.com`).
- The backend has `cors()` open, and auth is an `auth: Bearer` header rather than cookies, so `localhost:<any port>` is fine.

**A per-worktree launcher already exists** in the backend: `yarn local-workspace --frontend <fe-worktree> --mode dev|staging`.
- It runs backend and frontend per worktree on hashed port slots (backend 10000+slot, frontend 4000+slot).
- All worktrees share the **dev database** through one SSH tunnel. Code is isolated per worktree, data is not.

**Isolated data only exists in backend previews.**
- Each preview gets its own Postgres from a dev-db snapshot, with `reset_db` available.
- Limits: at most 5 stacks, a 7-day TTL, and third-party OAuth doesn't work.

**Login uses Firebase email/password through the UI.**
- After login, the backend JWT lives in redux persisted to **IndexedDB**. The existing setup saves `storageState({ indexedDB: true })`.
- That state is **tied to an origin**, so each `host:port` needs its own login or state file.
- The test user must **not** have MFA enrolled, because the tests don't handle OTP.

**There's an existing e2e suite to build on.**
- `tests/e2e/critical/` has 28 specs, with ~60 page objects in `tests/poms/`.
- Fixtures in `tests/_base.ts`: `entities`, `pages`, `poolUser`, `workerStorageState`, plus re-login on `sessionTimeout`.
- `tests/labels/dev.labels.ts` holds fixed entity IDs for the dev environment.
- Selectors are mostly `getByTestId`, then `getByRole`. Video is **not** configured.

**Credentials are read from env vars** (in CI they come from GitHub secrets):
- `E2E_TEST_USERNAME`/`E2E_TEST_PASSWORD` for the main user
- `E2E_WORKER_POOL_PASSWORD` for the pool users `eugene+e2eworker02..05@example.com`
- client-portal and Mailosaur variables

The frontend has no `op` usage. The backend already loads its env from 1Password (`example-team`, vault `Local Env`).

**The dev data is shared by everyone.** CI runs e2e there every hour (09–23 UTC, Mon–Fri) and the suite is `fullyParallel: false` because of shared entities. Any agent run that changes data must use its own entities or a pool user.

**Qase:** the existing suite reports to project **DA** with a custom client (`tests/utils/qase.api.ts`), not to DEMO.

**Internal admin tools** (DEMO-6611 and 6614):
- They're always allowed when the backend runs locally with `NODE_ENV=development`.
- On the dev environment, the email must be `@example.com`/`@example.app` **and** listed in the LaunchDarkly flag `internal-mcp-enabled-users`.

**Feature flags:** LaunchDarkly, keyed by practice. There's no local override, so test practices need their flags pinned.

## Proposed environment strategy for the PoC

| Iteration | Mode | Why |
|---|---|---|
| It-1 → It-3 | **Frontend-only worktree** (`yarn staging --port 4000+slot`) against the dev API, with one pool user per slot | No backend or tunnel needed, which is the fastest way to answer Q1, Q2 and Q4 |
| It-4 (parallel + backend changes) | `yarn local-workspace --mode dev` for worktrees that change the backend | Already built. Shares the dev DB, so pool users remain the isolation unit |
| Later | Backend previews for cases that need a clean DB | Isolated, but slow and capped at 5 |

**Parallelism limit:** with 4 pool users (`e2eworker02..05`) we can run 4 slots in parallel without two agents acting as the same user.

## Regression pairs (known-broken cases)

| Case | Fix | Pre-fix commit | Repo | Needs local backend? |
|---|---|---|---|---|
| **DEMO-6003** Shift+Enter list item persists | WMD-1920 `7e619ff129` (2026-08-18) | `04515988f4` | frontend | **No.** This is the best F/E pair |
| DEMO-6915 Task Name filter `(No Task Name)` + names | `42a3e624c4` (2026-09-21) | `de27537847` | backend | Yes (`local-workspace`) |
| DEMO-6914 Status filter after Select all | not found in either repo | — | — | — |

DEMO-6004 guards the *same* fix from the other side (single-line lists must stay unchanged), so it should pass both before and after the fix. That makes it a good control.

## Housekeeping noticed (outside PoC scope)

- `.github/workflows/deploy-preview.yml` in the backend contains a hardcoded Slack webhook URL in a committed file. The owner may want to rotate it.
- `*.pem` and `*_id_ed25519` files in the backend root are gitignored, so they aren't committed.
