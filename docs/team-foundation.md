# Team foundation

This is the first implementation slice of [milestone 1](research/team-web-roadmap.md): an independent checker API, PostgreSQL persistence, Clerk authentication, and a shared case workspace. Verification, worktrees, provider subscriptions, recording and demos continue to run locally.

The team client mounts the existing `src/app/client/App.tsx`, sidebar, thread, composer, dialogs and stylesheet. Shared cases appear in the existing sidebar; editing and account-session controls open in dialogs. Clerk gates this same workspace and its organization/account controls live in the Account dialog. The authenticated home route is `/`, and direct case links still work. The separate table dashboard and its layout/style definitions have been removed.

Shared case data comes directly from TanStack DB; selected IDs, dialogs and theme remain transient presentation state. The shared UI does not query local provider/worktree/job APIs or reuse a remembered local identity or run. Team execution and shared run history remain unavailable until the worker/run milestones are implemented; controls state that limitation. `npm run app` retains the existing local execution, settings and evidence flows.

Milestone 1 is **in progress**. Live Clerk admission/revocation and hosted staging have not been verified. Shared verification-session/run metadata, artifact metadata and a complete historical import are still pending. A sign-in session on the Account page is a Clerk login session, not a verification session.

## Runtime boundaries

| Component | Responsibility |
| --- | --- |
| `src/team/server` | Fastify API, Clerk verification, application permissions, transactions, migrations and provisioning CLI |
| `src/team/contracts.ts` | Browser-safe Zod contracts; internal UUIDs in domain records |
| `src/team/client` | Existing React/Vite app components and styles, TanStack Router/DB/Form; shared sidebar cases and case/account dialogs |
| `Dockerfile.team` | Independent Node 24 image with the API and built SPA; no worker entrypoint or target-backend source/configuration |

The API accepts Clerk bearer session tokens, restricts the active organization and trusted frontend origin, and checks current Clerk session and organization membership on every request. Clerk failure denies access. This adds provider traffic for the small pilot; measure limits and latency before expanding.

PostgreSQL owns internal identity mappings and `owner`, `admin`, `member`, `viewer` roles. Verified members of the configured Clerk organization receive a local `member` mapping on first login, including before a webhook arrives. Signing in without that membership grants no access. Existing disabled users/memberships and local session denials cannot be overwritten by first login. Owners can change or disable non-owner memberships through the API; admins can list members; viewers cannot change cases. The trusted CLI provisions the first owner.

`auth_sessions` contains non-secret session references, last-seen timestamps and local revocation flags, with no passwords or reusable login tokens. The Account page obtains session status from Clerk (up to 100 sessions). Revocation records a local denial and audit event before calling Clerk. Revoking the current session disposes the workspace. A provider failure cannot undo the denial; automated retry/reconciliation remains a rollout task.

Signed deletion webhooks create durable user/membership tombstones, even before first login. Deliveries are deduplicated. Creation/update events never restore access; a returning member needs explicit local re-enablement after their Clerk membership is restored. Profile synchronization and general reconciliation are pending.

## Persistence and frontend state

Each case write stores the canonical organization-scoped case, an application version and an attributed audit event in one transaction. Creates use a caller-generated UUID as an idempotency key; different content under the same key conflicts. Edits require the previously read revision. Write transactions recheck and lock user, membership and session access. API callers cannot supply their own author or organization.

The frontend uses a **direct TanStack DB adapter**, pinned to `@tanstack/react-db` `1.0.0-rc.1.1`. Checker application data uses no Query cache, Query hook or Query collection adapter. DB owns case records and live queries. Form handles editing; Router owns URL filters and selection; Clerk owns authentication. React state holds transient controls and the account view's provider-owned session response. Clerk brings `query-core` transitively for its SDK internals; checker domain state does not use it.

Authorized HTTP pages refresh on focus and every 15 seconds. Optimistic edits settle against server-confirmed revisions; failures roll back. Older snapshots cannot replace newer rows. Page IDs/cursors describe a partial result set, not the whole catalog. Retention is bounded to 250 cached rows while protecting open/pending cases. Identity changes abort requests and dispose collections; late responses cannot restore them. Revisioned SSE synchronization follows in milestone 2.

The case dialog supports title, project, status, description and ordered action/result steps. Other case fields survive edits and are supported by the API. Active cases require meaningful steps. Archived cases remain in this initial list; hard deletion and broader catalog controls are deferred.

## Local setup

Use Node 24 or newer and a dedicated PostgreSQL database. The service needs no target application/database, native model login or model API key.

1. Create a dedicated Clerk application, select the team's sign-in method, restrict admission to invitations, disable self-service organization creation, and create the pilot organization. Invite the owner. These dashboard settings are staging requirements; the API does not configure them automatically.
2. Run `npm ci`, then copy `.env.team.example` to `.env.team`. Fill in the checker database URL, Clerk publishable/secret keys and approved organization ID locally. Use development keys on localhost and production keys for production. `.env.team` is gitignored; keys are not embedded during the frontend build.
3. Run `npm run team:db -- migrate`. Migrations use a transaction, advisory lock and checksum validation. They never run automatically at API startup.
4. Seed the owner with `npm run team:db -- member org_YOUR_ORGANIZATION user_YOUR_OWNER owner "Owner Name"`, replacing both IDs with actual Clerk IDs. This requires trusted database access and does not create Clerk membership or issue tokens.
5. Run `npm run team:api` and `npm run team:dev` in separate terminals. Open `http://127.0.0.1:5174`. The Vite proxy forwards `/api/team` to port 4200. `TEAM_PUBLIC_URL` must match the browser origin exactly. The example sets `TEAM_SERVE_UI=false`, so development needs no prebuilt SPA.

For a built local SPA, run `npm run team:build`, set `TEAM_SERVE_UI=true` and `TEAM_PUBLIC_URL=http://127.0.0.1:4200`, then start the API. For a separate web host, proxy `/api/team` under the canonical frontend origin and set `TEAM_SERVE_UI=false` on the API.

Configure Clerk's webhook destination at `/api/team/webhooks/clerk` for `user.deleted` and `organizationMembership.deleted`, then set `TEAM_CLERK_WEBHOOK_SECRET` on the API. Verify delivery in staging. Current provider/session and local permission checks remain required regardless of delivery.

## Deployment and operations

```sh
docker build -f Dockerfile.team -t checker-team .
```

Deploy behind TLS with a canonical `TEAM_PUBLIC_URL`, managed PostgreSQL with TLS/backups, and server-side secrets. The image defaults to production, binds port 4200 and serves the SPA. Production requires matching live Clerk keys and HTTPS. Supply secrets through the deployment secret store, never image arguments or committed configuration.

Run `node src/team/server/cli.ts migrate` as a separate deployment job before starting the API. Use a separate runtime database role with schema usage and required table read/write permissions, without DDL ownership. Back up before schema upgrades. `/health/live` checks the process; `/health/ready` requires a reachable database and the initial migration. Readiness does not contact Clerk. SIGINT/SIGTERM close the API and database pool.

The API serves only built assets loaded at startup, supports SPA deep links, marks JSON `no-store`, bounds request bodies and applies an in-memory request limit. Multiple replicas require edge rate limiting. Authorization/cookie headers and database error details are excluded from application error output. Validate Clerk-compatible CSP, proxy headers, logging, retention, backup restoration and alerts before production rollout.

The trusted case-import rehearsal accepts one legacy case JSON file:

```sh
npm run team:db -- import-case org_YOUR_ORGANIZATION user_YOUR_OWNER /absolute/path/case.json
```

It requires a project and numeric case ID, maps snake-case step fields and derives a stable UUID. Repeating identical input under the same operator returns the existing receipt; changed input conflicts. Historical creators remain `null`, with the operator recorded only in the import audit. This is not a full migration of legacy revisions, provenance, sessions, runs or artifacts. Preserve the source stores for the full migration.

## Verification and remaining gates

Validated locally on 2026-11-01: all 181 automated tests passed with PostgreSQL enabled (22 team checks), the team browser flow and 240 existing UI checks passed, TypeScript checks and both frontend builds passed, and the Node 24 Docker image passed a PostgreSQL/API/SPA smoke test. `npm audit --omit=dev` reported zero vulnerabilities. Identity-dependent tests used fixtures; no live Clerk or hosted deployment result is claimed.

```sh
npm run check
npm run build
npm run team:build
npm test
npm run test:browser
```

Database tests require `TEAM_TEST_DATABASE_URL` pointing at a **disposable PostgreSQL instance with CREATEDB permission**. Each suite creates a randomly named database and drops only that database. Without this variable, the database integration test explicitly skips; the collection tests still run.

```sh
TEAM_TEST_DATABASE_URL="$CHECKER_TEST_DB_URL" npm run test:team
TEAM_TEST_DATABASE_URL="$CHECKER_TEST_DB_URL" npm run test:team:browser
```

The database suite checks actual transactions, team isolation, roles, conflicts, idempotency, migrations, signed webhook tombstones, session ownership/revocation, API restart and a case import. Collection tests cover confirmation/rollback, stale responses, pagination and identity disposal. The browser runner verifies the reused thread/sidebar/composer, desktop/mobile layouts and themes, modal navigation and the absence of local-runtime API requests in shared mode. It builds a test-only entrypoint outside the production bundle and uses the real API/database with an injected identity provider. It verifies edits, validation, conflicts, deep links/reload/history, pagination, read-only access, identity disposal and current-session revocation. These checks do not prove live Clerk login.

For a persistent local browser review without Clerk credentials, use the same disposable PostgreSQL instance:

```sh
TEAM_TEST_DATABASE_URL="$CHECKER_TEST_DB_URL" npm run team:review
```

Open `http://127.0.0.1:4210/` (override the port with `TEAM_REVIEW_PORT`). This builds the production workspace with a test-only identity selector, uses the real API and database, and seeds 28 `e2e-agent-seed-*` cases for pagination. Switch between member, viewer and signed out to inspect access behavior. The visible banner identifies the authentication fixture. The server binds to loopback; stopping it drops its randomly named review database. This entrypoint is excluded from the production image and does not exercise Clerk sign-in.

Remaining milestone-1 gates: test real invitations and expired/revoked tokens; measure Clerk-side removal/revocation with an existing token; prove reconciliation after provider failures; add shared verification-session/run and artifact metadata; rehearse session-preserving imports; deploy private staging in the selected host/region and verify with two developers. Worker enrollment/execution and shared artifact uploads follow the roadmap.
