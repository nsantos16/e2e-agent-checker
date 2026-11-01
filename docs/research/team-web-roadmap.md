# Team web delivery roadmap

Status: proposed delivery plan, 2026-11-01. Confirmed architecture: a standalone checker backend, with worktrees, verification, and demo generation on each developer's machine and shared status, history, and artifacts. Clerk is selected for authentication for the initial small team, TanStack is preferred across the frontend, and TanStack DB is selected for application data state. The checker owns its API, application permissions, database, storage, and deployment; Clerk owns login sessions. It requires no integration into the backend of an application being tested. See [team web architecture](team-web-architecture.md) for the system design.

Deliver six milestones, with a working flow across two developers by milestone 2 and shared demo playback by milestone 3. Complete reliability, access, migration, and operational checks before the team rollout. Each milestone should be reviewable and usable in staging; application authentication and authorization start in milestone 1.

## Decisions to make before implementation

Backend independence, local execution, shared results, Clerk authentication, the TanStack frontend preference, and TanStack DB state management are confirmed. The remaining choices below are recommendations, not recorded approvals.

| Decision | Recommended starting choice | Consequence and deadline |
| --- | --- | --- |
| Team sign-in method | Enable the team's chosen Google Workspace, GitHub, or Microsoft method within a dedicated Clerk application; invite-only admission | Select the method before milestone 1. Clerk owns authentication/session state; the checker owns identity mappings and application access. Signing in alone must not grant team access. |
| Team access model | One internal organization; owner/admin/member/viewer roles; organization-scoped domain records from the start | Decide before milestone 1. Public signup and multiple customer organizations introduce more onboarding and isolation work. |
| Hosting and region | A dedicated checker deployment in the chosen cloud/region: standalone Node API, web frontend, managed PostgreSQL database, and private object storage | Decide before hosted staging in milestone 1. Identify the checker domain, infrastructure owner, and monthly spending ceiling. The product backend is not a hosting or runtime dependency. |
| Supported developer machines | macOS first if that covers the pilot; add Linux/Windows when required by actual participants | Decide before milestone 2. Browser dependencies, credential storage, process lifecycle, and installation differ by platform. |
| Who may start work | A member can submit work only to their own enrolled workers; teammates can view permitted results | Decide before milestone 2. Shared visibility does not authorize use of another person's computer or subscription allowance. |
| Shared-service outages | Require connectivity to register/claim new work; buffer updates during brief disconnects and stop active execution when its lease expires | Decide before milestone 2. Starting new work while the shared service is unreachable needs a separate local admission and reconciliation design, especially for shared test accounts. Upload recovery is included regardless; native model calls still have their own connectivity requirements. |
| Evidence visibility and retention | Private team access with environment/project restrictions where needed; automatic upload of permitted outputs | Set visibility before milestone 3. Proposed retention: raw traces/logs 30 days, final demos/videos 90 days, run summaries/audit history 1 year; cases/configuration persist until explicitly removed. Confirm TTLs, exceptions, and storage limits before milestone 6. |

The earliest remaining choices are the sign-in method within Clerk, team access model, and approved hosting location. Worker platform, ownership, and offline behavior should be settled while milestone 1 is built. Evidence policy must be settled before real team data is uploaded.

## Engineering defaults

Clerk is the selected authentication service and TanStack DB is the selected frontend data-state layer. Suitable TanStack packages are the preferred frontend defaults. Other choices below can be taken as implementation defaults unless an existing infrastructure constraint changes them.

| Area | Proposed decision | Why |
| --- | --- | --- |
| Application structure | Separate checker backend, React/Vite frontend, Node/Effect worker, and shared contracts within `e2e-agent-checker`; independent runtime/build boundaries | Reuse this checker's verification/provider pipeline. Keep business-backend modules, routes, and deployment out of its dependency graph. |
| Frontend — TanStack preferred | TanStack Router for navigation; TanStack DB for application data state; Form with Zod for application forms; Table for data grids; Virtual for long lists when needed | Reuse React components and styling, add shareable typed routes, and read reactive collections. Keep React/Vite for the first SPA; reconsider TanStack Start when frontend server features are needed. |
| Frontend synchronization | A direct TanStack DB collection adapter over authorized HTTPS snapshots/commands and revisioned SSE changes | DB owns the browser collections and live queries. The checker API owns authorization, persistence, idempotency, and execution. Prove snapshot, mutation-confirmation, and stream reconciliation behavior incrementally in milestones 1–2. |
| Authentication — selected | Clerk for the initial team, integrated into React and the standalone API; invite-only access proposed | Clerk operates authentication and login sessions. The checker maps identities to internal IDs and owns domain roles/grants. Validate admission, session controls, synchronization, and revocation in milestone 1. |
| Shared persistence | Dedicated checker PostgreSQL for identity mappings, application memberships, auth audit observations, cases, verification sessions, jobs, ownership, events, and artifact metadata | Keep domain ownership and access checks independent of the product backend and of provider-specific IDs. Clerk remains authoritative for login sessions. |
| Local persistence | A small transactional worker journal, with SQLite as the proposed implementation; media remains in local staging files | Persist event acknowledgements, attempts, and upload checkpoints across worker restarts. The hosted database remains authoritative for shared configuration and admitted requests. |
| Job scheduling | PostgreSQL-backed claims, leases, and resource locks, behind a repository interface | Keep scheduling in the same durability boundary as run creation; add a separate broker only if measured load warrants it. |
| Connectivity | Workers initiate HTTPS connections and pull/long-poll for their jobs; the browser receives authorized SSE events | Supports developer machines without inbound ports, stable LAN addresses, or tunnels. Test proxy buffering and connection limits in staging. |
| Artifact delivery | Private S3-compatible objects; permission-checked short-lived access; persisted multipart uploads for large media | Videos stay out of the database and API request path; uploads can recover without repeating execution. Verify the selected store's multipart behavior. |
| Worker packaging | A versioned CLI/worker package with enrollment, status, diagnostics, and update compatibility checks | Validate installation and recovery before investing in a separate desktop application. Foreground execution is sufficient for the first slice; background startup follows the pilot OS choice. |
| MCP | Preserve local stdio MCP with scoped access to the shared API for the first release | UI and local MCP can use the same domain permissions. A hosted HTTP MCP endpoint requires additional OAuth integration and can follow separately. |

Clerk documents [invite-only access](https://clerk.com/docs/guides/secure/restricting-access), [React organization management](https://clerk.com/docs/react/guides/organizations/getting-started), and [Fastify authentication](https://clerk.com/docs/fastify/getting-started/quickstart). PostgreSQL documents [`SKIP LOCKED` for queue-like consumers](https://www.postgresql.org/docs/current/sql-select.html). S3 documents [multipart upload recovery](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html). These capabilities support the design; the integration proofs remain milestone work.

## Milestone 1 — Independent backend and team identity

**Outcome:** two invited people can sign in to the independently deployed checker and see shared case/session metadata with correct permissions, even when a target backend is unavailable.

Establish the checker's backend module, API contracts, dedicated database, configuration, and deployment. Keep its frontend and worker as explicit clients. No checker routes, database migrations, auth hooks, or runtime package installations are required in a product backend. Optional local source/schema inspection for mock generation remains an input to the worker.

Configure a dedicated Clerk application, the selected sign-in method, and an approved organization with a seeded owner. Integrate Clerk's React sign-in/account UI and server authentication, validate invite-only admission, and implement Clerk session listing/revocation. Keep login sessions, verification sessions, provider sessions, and target test accounts distinct. Introduce provider-neutral authenticated actor context and rename the existing test-account `userId` semantics before adding teammate attribution.

Store internal user/organization IDs mapped to Clerk, application memberships/roles/grants, non-secret login observations, and audit records. Add verified webhook ingestion, deduplication, and reconciliation for delayed/out-of-order changes. First-login admission must use server-verified state without depending on webhook timing. Persist local denials before requesting provider-side removal/revocation; document token-expiry and webhook delays for changes made directly in Clerk. Reauthenticate event streams before their token expires. Confirm the session policy and required features against the chosen Clerk plan.

Add checker-owned PostgreSQL migrations and repository interfaces for shared state. Establish organization-scoped foreign keys, immutable case/run inputs, optimistic revision checks, and artifact metadata. Deploy the standalone API and web UI to private staging with a canonical HTTPS URL and basic logs/health checks. Use fixtures and a representative checker-data import sample while existing local use continues.

Establish the TanStack Router route tree, Clerk-aware route context, and TanStack DB collections over shared typed API contracts. Implement the direct HTTPS collection adapter for initial snapshots, refreshes, confirmed mutations, and disposal; use collection-backed live queries for the first case/session list and detail view. Validate the selected DB version and adapter lifecycle before expanding screens. Introduce TanStack Form for application editors and TanStack Table for the first structured listing, with validated URL filters and loading/error states. Scope collections/subsets to the active identity and organization; dispose protected state and stop requests/streams when access changes. Deploy SPA route fallbacks so a shared link loads directly.

**Completion checks:** anonymous access is rejected; an uninvited identity or wrong organization cannot join; viewer mutations fail; checker-side removal blocks access and active streams; spoofed requester IDs do not change attribution; fixture imports preserve session membership and unknown historical creators. Clerk login and shared metadata survive an API restart. First login works before its webhook arrives; duplicate/stale events cannot restore removed access. Measure Clerk-side revocation delay with an existing token, reconcile dashboard membership changes, and verify expired tokens/streams are rejected. Clerk failures cannot admit unknown users or bypass checks that require current provider state. Checker login and metadata browsing work without a target backend; the checker build/deployment uses no product-backend modules or database credentials.

**Frontend checks:** direct links and browser back/forward restore the intended route and filters; signed-out navigation returns through Clerk; switching identity cannot expose or repopulate another member's collections. Confirmed edits update list/detail views together; rejected optimistic edits roll back and show validation/conflict errors; a reload reconstructs state from the API; paginated subsets report incomplete coverage correctly. Backend authorization remains effective when route guards are bypassed.

## Milestone 2 — One local worker and one shared run

**Outcome:** developer A runs an existing case on their own machine; developer B sees its status and a small uploaded report through the shared app.

Extract local execution from the HTTP server behind a versioned worker protocol. Implement one-time enrollment authorized by a Clerk-authenticated browser session, separate revocable device credentials, worker ownership, workspace bindings, capability reporting, and outbound job polling. Resolve native provider profiles and target credentials locally. Keep local paths and secret files out of shared payloads; Clerk backend keys remain on the hosted API.

Implement the minimum durable path: create request and idempotency receipt transactionally, claim it for the correct worker, record an attempt and lease, send ordered progress, finalize, and upload one private report. Include basic cancellation and expiry handling from the first worker implementation. Exercise the existing verification pipeline rather than replacing it.

Extend the DB adapter with authenticated SSE changes, snapshot/event-cursor ordering, revision checks, deletion handling, and subscription cleanup. Reconcile after reconnecting, reloading affected subsets when events are incomplete or cursors expire. Reuse backend idempotency keys for retried run submissions; only confirmed events mark execution running or completed. Verify duplicate/out-of-order events and snapshot/stream races cannot regress the displayed status or restore deleted rows.

**Completion checks:** the job executes on A's machine; B can read permitted results but cannot claim/control A's worker; duplicate submission does not create duplicate work; an offline worker's request stays queued; a hosted API restart does not kill a healthy local process or lose queued requests; report access is private.

**Gate:** prove this complete flow before broadening demo/media support or administrative UI. This resolves the highest architectural uncertainty early.

## Milestone 3 — Local demos and shared artifacts

**Outcome:** A records/renders a demo locally, uploads it, shuts down the laptop, and B can still watch it.

Add tracked local demo jobs, narration configuration, rendering, replay, and source-run provenance using the existing demo/provider behavior. Support private video/audio/screenshot/trace/suite objects, upload manifests, checksums, byte limits, multipart checkpoints, and upload completion acknowledgements. The worker retains outputs until durable storage is confirmed.

Track execution outcome separately from artifact synchronization. Show completed-with-upload-pending accurately. Authorize every artifact lookup and playback request; support video ranges. Serve active or untrusted artifact formats from an isolated origin or as attachments, not as executable content under the authenticated application origin. Exclude credential files and browser storage state; validate redaction on representative reports/traces.

**Completion checks:** playback works with the producer offline; an interrupted upload resumes/retries without regenerating the demo; duplicate upload completion does not create duplicate records; corrupt or unauthorized uploads are rejected; unrelated members cannot download restricted evidence; HTML artifacts cannot execute in the app's authenticated origin.

Milestones 1–3 produce the first constrained internal demonstration. Broad team use waits for the following recovery and operational gates.

## Milestone 4 — Recovery, cancellation, and synchronization

**Outcome:** network loss, worker restarts, API deployment, and repeated delivery produce an accurate shared history.

Complete the durable local journal and event/upload outbox. Persist acknowledgements and replay only unacknowledged updates. Add heartbeat expiry, stale-lease fencing, worker reconnection, bounded local spool storage, upload cleanup, and protocol compatibility handling. A full disk must surface an actionable failure rather than silently dropping unsynced evidence.

Enforce shared test-account and workspace concurrency across workers. Distinguish cancellation requested from acknowledged, and disconnected from failed. Reconcile uncertain attempts before admitting retries: database fencing cannot prevent a stale browser from making external changes, so mutating jobs must not be blindly replayed after a lost connection.

**Completion checks:** restart each component mid-run and mid-upload; duplicate/reorder updates; expire a lease; revoke a device; submit two jobs using the same test account from different machines. Confirm no lost acknowledged history, no stale overwrite, no duplicate published output, and no automatic re-execution of uncertain mutations.

## Milestone 5 — Team workflow and UI/MCP parity

**Outcome:** teammates can use the hosted UI or local MCP for normal daily work with the same permissions and attribution.

Finish member invitations/roles, active-device management, worker onboarding/status, per-member provider selection, shared verification sessions, run filters, replay-on-my-machine, demo generation, and private evidence links. Display the selected worker, target environment, actual build provenance, and last confirmed update clearly.

Extend TanStack Form and Table across the remaining application editors and structured lists. Use Router search parameters for shareable history filters and TanStack Virtual for large logs/history where needed. Preserve accessible controls, existing styling, server pagination, and useful loading/error/empty states as screens migrate.

Wire local MCP to authenticated shared operations through a separately scoped, revocable enrollment grant authorized by the member's Clerk login. Record the client/device actor without trusting caller-supplied attribution. Apply environment execution/write permissions at admission and execution; provide minimal test-account access for the pilot. Audit external publication, cancellation, settings changes, and artifact access where required. Preserve existing session summaries, demos, provider accounts, and mocked-suite provenance.

**Completion checks:** the same allowed/denied actions behave consistently in UI, local MCP, and direct API requests; removing access terminates new operations and live visibility; another member's replay uses the requester's authorized machine and provider; publication records the authorized requester and output.

## Milestone 6 — Migration and team rollout

**Outcome:** the pilot team uses the shared system with a tested recovery procedure and an owner for operations.

Rehearse importing existing checker cases, sessions, jobs, and retained artifacts; product-backend data is outside this migration. Check IDs, references, counts, hashes, revisions, tombstones, and unknown attribution. Map each local repository/provider to its owning worker without moving credential homes. Take a final snapshot and freeze legacy checker shared-data writes during cutover; keep execution journals local. Define rollback before enabling new authoritative writes, including how to preserve any post-cutover jobs/events rather than discard them.

Finish production configuration, least-privilege storage/database access, backup and restore, object lifecycle rules, metrics/alerts, request/upload/concurrency limits, and spend monitoring. Document enrollment, update, disconnect recovery, revocation, retention, and support procedures. Test the supported OS installation from a clean developer setup.

**Completion checks:** two people on two machines complete verification and demo workflows; uploaded evidence remains available with both machines offline; a restore reconciles database references and retained objects; an old worker version fails clearly or drains safely; migration counts/hashes match; the agreed retention and usage limits work.

## Implementation order and scope

Use incremental changes: standalone checker backend, identity, repositories, and TanStack frontend foundation → worker protocol and one case → local demo and media upload → recovery drills → team UI/local MCP → migration and rollout. Build enough UI for each milestone to be reviewable, adopting the preferred TanStack packages as each screen is migrated. Authentication, authorization, and basic fault handling belong in every applicable milestone; later milestones extend coverage and recovery rather than introduce those protections for the first time.

Backlog member attribution is foundational work in milestone 1. Concurrent-environment presentation and environment write permissions enter milestones 4–5. Backend-derived mocking should store its suite/schema provenance through the same run/artifact interfaces. Persona configuration can follow the team pilot. Provider harnesses, summaries, and voice demos should be adapted to worker ownership and shared storage rather than rebuilt.

Defer public signup, billing, multiple customer organizations, cross-member machine control, a desktop shell, full offline job creation, and hosted HTTP MCP unless a launch requirement makes one necessary. Central browser/demo execution is outside the confirmed architecture.

Set calendar dates after the sign-in method/OS/hosting choices and the milestone-2 worker proof. The main estimation risks are Clerk integration and access synchronization, browser/provider installation on the supported OSes, artifact upload sizes, disconnect behavior, and the quality of legacy data. No implementation sessions, infrastructure resources, or deployments are created by this plan.
