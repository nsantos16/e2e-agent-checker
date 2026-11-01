# Team web architecture

Status: independent checker backend, local-execution/shared-storage split, Clerk authentication, preference for TanStack across the frontend, and TanStack DB for application data state confirmed by the user; implementation remains proposed. These stack choices were selected 2026-11-01 for the initial small-team rollout. The original code audit was prepared 2026-11-01 against `origin/main` at `1c3c5c59225804765cbd7c099caf36064dd5e1a3`; the working checkout was older, so that audit used the main revision explicitly.

## Selected architecture

Keep the checker's existing React/Vite UI and Node/Effect verification pipeline. Use TanStack DB for frontend application data state, and prefer TanStack for routing, forms, tables, and long-list rendering. Build a standalone checker backend with its own PostgreSQL database and private object storage, use Clerk for authentication, and separate execution into authenticated local workers. References to the existing codebase mean `e2e-agent-checker`, not the backend of an application being tested.

Confirmed requirement: worktrees, verification, and demo generation execute locally on each developer's machine; status and artifacts are available in a shared team space. Central execution is outside the selected scope. Invite-only access for one internal organization remains the proposed admission policy. Clerk is the selected authentication service; the sign-in method enabled within Clerk and the hosting provider remain open choices.

### Independent backend boundary

The checker is a standalone product with its own API, application user and organization records, job coordination, database migrations, storage permissions, configuration, and deployment lifecycle. A dedicated Clerk application manages its authentication identities and login sessions. Its backend is independently deployable from its web UI and local workers; those components can remain in this checker's repository with explicit API/protocol contracts.

The application being tested is an external target. Local workers interact with its existing UI/API using configured test accounts. Backend-derived mocking can inspect explicitly supplied source code and schemas on the developer machine; it does not require installing checker routes, libraries, or database tables in the target backend. Target-specific behavior belongs in configuration or optional worker adapters, not imports of business-backend services into the hosted checker.

Checker authentication uses a dedicated Clerk application; checker authorization uses application-owned memberships, roles, and grants. Google/GitHub/Microsoft sign-in can be configured within that Clerk application. Reusing an identity provider does not reuse the product backend's login endpoints, cookies, authorization logic, or database. Backend independence permits this external authentication dependency.

Use dedicated checker deployment resources, database credentials, and artifact storage permissions. Hosting may be chosen independently. The shared checker can serve sign-in, history, and uploaded evidence even when a target backend is unavailable; only work requiring that target should report its unavailability.

The hosted checker service owns identity mappings, application permissions, shared cases, job requests, history, and evidence access; Clerk owns authentication and login-session state. Local workers own repository worktrees, browser execution, native provider processes, target-app login, demo recording, narration orchestration, and media assembly. They connect outward to the service over HTTPS; teammates do not expose their laptop's HTTP server to the internet.

This preserves the current subscription workflow while making results available to the team. A personal worker only executes its owner's requests initially. Sharing a result does not give another member permission to run code on that machine or use its provider account.

| Responsibility | Developer machine | Shared service |
| --- | --- | --- |
| Execution | Worktrees, verification/replay, demo and voice jobs | Authorized requests addressed to the owner's worker |
| Credentials | Native Claude/Codex profiles, target login state, secret resolution | Member/device identity, grants, non-secret capability metadata |
| Progress | Local execution journal and upload queue | Database history, last confirmed status, live team updates |
| Evidence | Produce and stage videos, audio, traces, suites, and reports | Private durable artifacts and permission-checked playback/download |
| Availability | Must be connected to claim new work | Uploaded evidence and history remain available after the developer goes offline |

One checker repository with separate backend, web UI, worker, and shared-contract modules is sufficient initially. Each runtime has its own build/start/deployment boundary. PostgreSQL can handle the first durable queue; Redis and Kubernetes are not prerequisites.

## What the current implementation requires us to change

| Current boundary on main | Required change |
| --- | --- |
| `src/app/server.ts` binds to loopback and uses localhost Host/Origin checks; there is no team authentication | Public URL/proxy configuration plus authentication and authorization on every resource route |
| `src/jobs.ts` snapshots a process-local map to `.state/jobs.json`; queue, active jobs, and cancellation handles live in memory | Database-backed submissions, leases, events, attempts, and cancellation |
| Restart marks queued/running/cancelling jobs interrupted | Recover state from worker leases; an API restart must not interrupt independent workers |
| `src/sessions.ts` stores groups of job IDs in `sessions.json` | Preserve verification-session grouping separately from browser login sessions |
| `Job.userId` selects the target application's test user | Rename to `testAccountId`; derive `requestedByUserId` from authenticated identity |
| Cases/environments have Effect repository interfaces; other stores still access files directly | Extend repository boundaries and replace shared persistence with PostgreSQL |
| Evidence URLs include localhost and `/files?path=...` serves filesystem artifacts | Use stable artifact IDs, permission checks, and private object storage |
| Provider profiles, worktrees, browser storage state, and 1Password access are machine-local | Keep them behind a worker boundary; publish capability metadata rather than credential files |
| MCP uses stdio and a local unauthenticated app connection | Add authenticated API access and a separately authorized remote MCP transport |

The recent provider-instance, session-summary, demo, and archive features remain part of the design. Their persistence and ownership change; their product behavior should be reused.

## Frontend architecture

Use TanStack as the default choice for the frontend capabilities below, with TanStack DB selected for application data state. Adopt it as each shared-team screen is built or migrated, reusing existing React components and styles. Prefer a suitable TanStack package before adding a competing library or custom infrastructure for the same responsibility. Pin compatible versions and validate the selected DB collection/sync APIs in milestone 1.

| Responsibility | Default | Application use |
| --- | --- | --- |
| Navigation and URL state | [TanStack Router](https://tanstack.com/router/latest/docs/installation/with-vite) | Typed file-based routes, validated search parameters, shared run/session links, history filters, nested layouts, pending/error states, and Clerk-aware navigation |
| Application data state — selected | [TanStack DB](https://tanstack.com/db/latest/docs/overview) | Typed collections, reactive live queries, derived views, and optimistic mutations for cases, runs, artifacts, workers, and team settings |
| Application forms | [TanStack Form](https://tanstack.com/form/latest/docs/framework/react/guides/validation) with shared Zod schemas | Case/environment editors, run/demo requests, and settings; field errors and asynchronous submission; Clerk retains its sign-in/account flows |
| Data grids | [TanStack Table](https://tanstack.com/table/latest/docs/overview) | Run history, cases, workers, and member lists with sorting, filtering, selection, and server pagination where appropriate |
| Long lists and feeds | [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction) | Large run/event/log views and table rows when rendering volume warrants virtualization |

The first frontend remains a React/Vite single-page application consuming the independent checker's HTTPS API. TanStack Router integrates with Vite directly. TanStack Start remains an option if server rendering, prerendering, or other frontend server features become requirements; it supports [SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode) and does not require moving checker domain services into frontend server functions. The first release has no server-rendering requirement.

Share typed API contracts and Zod validation with the backend while keeping server credentials and implementation modules out of the browser bundle. Define TanStack DB collections with stable resource IDs; screens read live queries and derived views over those collections. Route loaders prepare the required collection/subset and share it with the screen. Use a collection sync adapter directly over the checker's HTTPS API and SSE protocol, without a separate Query cache or Query-backed collection adapter. The adapter owns initial snapshots, subsequent refreshes, authenticated subscriptions, and cleanup. This integration is implementation work, not automatic REST synchronization supplied by DB. Source: [custom collection integrations](https://tanstack.com/db/latest/docs/guides/collection-options-creator).

Scope collection instances and loaded subsets by authenticated user/organization and authorized resource/filter/pagination inputs. Wait for Clerk initialization and approved membership before loading protected data. On sign-out, revocation, or identity/organization change, dispose the old collections and subscriptions, cancel requests, discard protected state, and reject late results from the previous identity. Route guards guide navigation; the backend still authorizes every fetch, subscription, and mutation. Keep the first browser collections in memory; the worker's durable SQLite journal remains separate. Transient presentation state, such as an open dialog, stays local to React, and form drafts belong to TanStack Form.

Feed authorized API snapshots and revisioned SSE changes through the adapter into DB's synced collection state. Coordinate snapshots with resumable event cursors, apply ordered batches, ignore duplicate/stale revisions, and process deletions or revoked visibility. Refresh an affected subset when an event lacks enough data; reload it when its cursor expires. Retain resource/subset ownership when a row appears in multiple loaded pages, and distinguish an unloaded row from a deleted resource. PostgreSQL remains authoritative for shared data and job admission; DB is the reactive browser view. Live queries operate on loaded data, so API filtering/pagination must bound retrieval and indicate when results are incomplete.

Persist edits through DB mutation handlers or explicit actions that call authorized API endpoints. Apply the confirmed response to synced collection state, or await the matching sync update, before settling the optimistic transaction. Roll back rejected optimistic edits and surface validation/revision conflicts. A frontend transaction is not a database transaction across HTTP requests; domain operations requiring atomicity use one backend transaction. Run/demo submission and cancellation use explicit backend commands and idempotency keys; display requested/pending state until server acknowledgement, and derive running/completed status from confirmed execution events. Source: [DB mutation handling](https://tanstack.com/db/latest/docs/guides/mutations).

Form validation supplements server validation. TanStack Table consumes collection-backed live results, with shareable filters/sort state in validated Router search parameters. Use API pagination to limit fetched data and Virtual to limit rendered rows. Browser offline mutation replay is outside the first release; disconnected workers continue to follow the existing lease and journal protocol.

## Identity, login, and permissions

**Selected authentication service: Clerk.** Use a dedicated Clerk application for the initial small internal team, with its React integration and server SDK in the independent checker API. Clerk handles sign-in, authentication identities, and login sessions. PostgreSQL stores application users, identity mappings, permissions, run attribution, and audit records. Sources: [Clerk authentication model](https://clerk.com/docs/guides/how-clerk-works/overview), [React integration](https://clerk.com/docs/react/getting-started/quickstart), [Fastify integration](https://clerk.com/docs/fastify/getting-started/quickstart).

Proposed pilot admission: configure Clerk's invite-only mode and one approved organization; select the team's sign-in method before milestone 1. Require both valid authentication and approved checker membership. Disable self-service organization creation for the pilot and reject other organizations at the API. Validate the complete invitation-to-membership flow rather than assuming sign-in alone grants access. Clerk organizations supply invitations and membership information; the checker retains the application roles and environment/worker grants below. Sources: [restricted access](https://clerk.com/docs/guides/secure/restricting-access), [organizations](https://clerk.com/docs/react/guides/organizations/getting-started).

Map Clerk's stable user ID within the configured instance/issuer to an internal user ID, and its organization ID to an internal organization ID. Keep internal IDs on cases, runs, artifacts, and grants. Authenticate each browser/API request with the server SDK, validating token signature, expiry, issuer, and allowed client origins, then load current checker access. Expose a provider-neutral actor context to domain services so a future auth migration does not rewrite run ownership. Never trust email, a display name, or a caller-supplied identity as the binding.

Synchronize identity and membership metadata through signature-verified, idempotent webhooks, with duplicate/out-of-order handling and reconciliation. Complete first-login admission from server-verified Clerk state instead of waiting for a webhook; unknown or inactive membership grants no access. A stale event must not reactivate a locally removed member. Webhook projections and observed session metadata support history, not independent login validation. Source: [Clerk synchronization guidance](https://clerk.com/docs/guides/development/webhooks/syncing).

Keep these concepts distinct:

| Concept | Meaning | Persistence/ownership |
| --- | --- | --- |
| Team member | Person allowed to use the checker | Clerk identity/organization membership mapped to an internal user and application access record |
| Login session | One authenticated browser/device | Clerk session authority; local non-secret session references and observations for auditing |
| Verification session | Named collection of runs for a feature or PR | Organization-owned session and run memberships |
| Run / attempt | Requested verification and a particular execution | Requesting member, worker, snapshots, status, events, timestamps |
| Provider session | Claude/Codex runtime conversation | External session/turn IDs on an attempt; credentials remain with the runtime |
| Test account | User logged into the application being tested | Environment account metadata and secret references; browser state stays on the worker |

A member's account page should obtain active login sessions from Clerk and offer their revocation through Clerk. Let its SDK manage the authentication cookies/token flow; configure HTTPS, trusted origins, and appropriate mutation protections around the API. Keep a finite session lifetime and require recent authentication for sensitive account changes. Proposed pilot policy: seven-day inactivity expiry and a 30-day maximum, subject to the selected Clerk plan and supported settings. Inactivity expiry requires a paid production plan; confirm the launch policy and required features before rollout. Source: [session options](https://clerk.com/docs/guides/secure/session-options).

Keep checker membership, grants, and local access blocks authoritative in PostgreSQL. For removal through the checker, persist the local denial first, close live streams, disable worker/MCP grants, prevent new leases, and request cancellation of affected active work; then reconcile the Clerk membership/session changes with retryable delivery. Session-revocation actions also record a local denial for the affected session IDs before calling Clerk. Remote cancellation cannot undo side effects already performed.

Offline JWT verification does not observe a Clerk-side revocation until token expiry or a separate status check. Changes made directly in Clerk also reach local membership records asynchronously. Measure and document those delays in milestone 1; use a current Clerk status check where immediate provider-side revocation is required, denying the operation if that check cannot complete. End or reauthenticate live streams by token expiry and recheck local access while streaming. A browser sign-out and revocation of a worker's separate device grant are distinct actions. Source: [Clerk token and refresh behavior](https://clerk.com/docs/guides/how-clerk-works/overview).

| Role | Initial permissions |
| --- | --- |
| Owner | Admin permissions plus ownership transfer and organization lifecycle |
| Admin | Invite/remove members, configure shared projects/environments, cancel team runs, manage retention |
| Member | Read permitted team evidence, manage cases, submit runs on authorized workers/environments, cancel own runs |
| Viewer | Read permitted cases, history, and evidence |

Use explicit environment/worker grants for execution and publication. Admin status does not expose provider secrets or grant arbitrary access to another person's computer. Start with organization-wide visibility for normal case/run metadata; restrict sensitive evidence and execution separately. Apply the same policy in HTTP, MCP, exports, artifact access, and event streams. Never accept a caller-supplied member ID as the acting identity.

## PostgreSQL model

The following are logical names, not a ready-to-run migration. Clerk owns authentication identities, invitations, and session issuance. Store mappings and application access records, not a parallel password or login-token store. Local session observations must not be presented as an authoritative list of active Clerk sessions.

| Area | Tables and important relationships |
| --- | --- |
| Identity and application access | `users`, `auth_identity_bindings`, `organizations`, `memberships`; stable internal IDs, unique Clerk instance/user and organization mappings, application roles/access state |
| Authentication tracking | `auth_session_observations`, `auth_access_blocks`, `auth_webhook_receipts`; non-secret session IDs, observed timestamps, local denials, event deduplication/reconciliation |
| Configuration | `projects`, `environments`, `test_accounts`, `execution_grants`; secret references only |
| Execution inventory | `workers`, `provider_instances`, `workspace_bindings`; member ownership, capabilities, last heartbeat, revocation |
| Cases | `cases`, immutable `case_versions`; stable IDs, revisions, archive/delete state |
| Work | `verification_sessions`, `session_runs`, `runs`, `run_attempts`, `run_events`, `demo_jobs`; demo jobs record requester, worker, source runs, attempts, and progress using the same execution protocol |
| Evidence | `artifacts`, `demo_outputs`, `publications`; object keys, checksums, size, media type, provenance, retention |
| Coordination | `resource_leases`, `idempotency_receipts`; execution and account/workspace concurrency |
| Accountability | `audit_events`, usage records; actor, action, resource, outcome, time |

Every organization-owned row needs `org_id`. Enforce organization-scoped lookups and composite foreign keys so that a run cannot reference another organization's case or artifact. Identity users may be global. Database row-level security can add defense in depth, but only with tested non-bypass database roles and transaction-local tenant context; it does not replace application permissions. See [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

Key relationships and constraints:

- Membership is unique by organization/user. Keep historical actor attribution after a member leaves or their Clerk identity is deleted; deletion disables access without deleting run history.
- A verification session can contain many runs; use `session_runs` so existing explicit and batch groupings can coexist.
- A run records its requester, test account, case version, environment revision, requested provider/model/settings, execution destination, replay source, and immutable input snapshots.
- An attempt records the worker, resolved provider version/account identity, lease generation, start/finish times, failure reason, and provider session IDs. Retries create attempts rather than rewriting history.
- Record the actual commit/build and dirty-worktree provenance observed at execution. Do not claim a local dirty checkout can be reproduced elsewhere without an explicit snapshot.
- Events are unique by attempt/sequence and support resumable progress. Store structured event data in JSONB; put large logs, traces, videos, audio, and generated suites in object storage.
- Index organization/project/time history, run status/availability, attempt events, and artifact ownership. Keep optimistic revision checks for shared case/session edits.

Store login metadata only for account security and the chosen retention period. Authentication tokens and native provider credentials must never appear in run snapshots, logs, or audit payloads. The global selected provider becomes a per-member preference constrained by available worker grants.

## Run lifecycle and worker protocol

1. A member submits a case/version, target environment, test account, and their worker/provider selection through the UI or local MCP. Both entry points register work through the shared API before execution, obtaining the same shared run identity. The API authenticates the request, checks grants, and resolves configuration.
2. One database transaction creates the run, immutable request snapshot, initial event, and actor-scoped idempotency receipt. Reusing a key with different input produces a conflict.
3. An eligible worker requests work. The API atomically claims a ready run and acquires its resource leases. PostgreSQL `FOR UPDATE SKIP LOCKED` is a suitable primitive for competing queue consumers; keep this transaction short. See [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html).
4. The worker receives a lease and narrowly scoped job capabilities, verifies local repository/provider state, and starts the existing verification pipeline. It reports heartbeat and sequenced events through authenticated endpoints.
5. The worker uploads evidence using job-scoped upload authorization. The service verifies size/checksum/ownership, persists artifact metadata, and finalizes the attempt only for the current lease.
6. Authenticated clients receive progress through SSE with an event cursor. Reconnection reads durable events; notifications are an optimization, not the source of truth.

Demo creation and regeneration use the same owner-bound job protocol. The shared UI offers “Run on my machine” and “Generate demo on my machine”; only that member's enrolled worker claims the request. Recording, narration orchestration, and rendering happen there, and the final video/audio/report uploads to the shared space. Where narration uses a remote speech provider, its configured credentials are resolved by the local worker. Playing an already-uploaded demo requires no worker connection.

### Synchronization and disconnected machines

Persist a local execution journal and upload queue before sending updates. Acknowledge events by job/attempt/sequence and retry delivery idempotently after reconnecting. Keep artifact manifests and checksums locally until the service verifies durable storage; resume or retry uploads without rerunning verification or regenerating a demo.

Track execution outcome, worker connectivity, and artifact availability independently. For example, a run can be completed with its video still uploading. The shared UI should show `queued`, `running`, `completed`, `failed`, or `interrupted` execution alongside `connected`/`disconnected` worker status and `pending`/`uploading`/`available`/`failed` artifact state. Record the last heartbeat and confirmation time; a stale connection must not look like fresh progress.

An offline machine cannot claim new work. Requests addressed to it remain queued; they do not move to another developer. During a connection loss, preserve local events and outputs while applying the lease-expiry behavior below. On reconnect, reconcile the attempt before accepting a terminal status; late events from an expired lease can be retained as historical evidence but cannot overwrite the current attempt. Retry evidence uploads independently, subject to current access. Uploaded artifacts remain readable by authorized teammates when the producing machine is asleep, disconnected, or shut down.

Do not hold a database transaction open during a browser run. Use heartbeats, expiry, and monotonic lease generations to reject late updates from an old worker. Preserve the existing test-identity and worktree concurrency rules with database resource leases, including a canonical shared test-account key across workers.

Delivery is at least once. Fencing database writes does not prevent an old browser from modifying an external application. A disconnected worker must stop after losing its lease; uncertain mutating runs remain interrupted/unknown until reconciled rather than being automatically replayed. Safe retries still need a new recorded attempt. Cancellation is a durable request followed by worker acknowledgement, with pending/unknown states visible in the UI.

Enroll a personal worker with a short-lived, single-use enrollment code bound to the signed-in member and organization. Issue a revocable device credential; store only its hash or public key on the server. Keep repository path mappings local and address them remotely by binding IDs. Accept registered capabilities, never arbitrary remote binary paths or shell commands.

Native provider credentials remain in their existing account profiles. The server stores account ownership, provider kind, auth mode, capability/status metadata, and opaque identifiers. Keep native sign-in native; a checker login must not become a shared Claude/Codex subscription login. This follows the documented authentication boundaries: [Claude credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use), [Codex authentication](https://developers.openai.com/codex/auth).

For personal workers, show offline/busy/auth-required states and leave work queued for the chosen owner. Replaying another member's result requires a compatible repository/environment binding and the new requester's authorized worker/provider. Never silently transfer work or billing to another account.

Keep the API process and database credentials out of local generated-test execution. Personal workers remain trusted developer tools; process separation alone is not a sandbox. Generated tests should not inherit provider credential directories, and the native harness should receive only the stage tools it needs. Worktree paths and native credential homes stay local; shared provenance identifies the repository, commit, branch, dirty state, and opaque workspace binding.

## Evidence, environment access, and integrations

**Evidence:** private S3-compatible storage, with database metadata and organization/run/attempt ownership. Replace path-based downloads with artifact IDs. Authorize each download before issuing a short-lived URL; use a checked proxy where immediate revocation is required. Presigned URLs can be reused until expiration, so removing a membership does not instantly invalidate an already-issued URL. See [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

Support video range requests, artifact checksums, upload limits, lifecycle deletion, and separate retention for raw traces versus summaries. Keep browser storage state and secret material out of general evidence uploads. Scrub target data, headers, and secrets before sharing traces or external publications. Purge metadata and objects through a retryable maintenance job; preserve a clear “evidence expired” state.

**Environments:** configure which members and workers may use each environment/test account, whether mutations are permitted, and the concurrency limit. Enforce restrictions through actual target permissions and execution/network controls. A prompt saying “read only,” or blocking a few HTTP verbs, does not establish read-only behavior. Launch the pilot with approved test/staging environments. Backend-derived mock suites should retain schema/source versions and mark mocked versus live traffic explicitly.

**MCP:** keep the stdio adapter for the first team release, with authenticated access to the shared API and the same member permissions as the web UI. Use a Clerk-authenticated browser enrollment to authorize a separate, revocable worker/MCP grant; store it securely on the developer machine instead of copying browser cookies or distributing Clerk backend secrets. A hosted HTTP MCP endpoint can follow separately; it requires an authorization server, protected resource metadata, audience validation, PKCE, and scoped tokens. Browser session cookies alone do not implement remote MCP authorization. CI uses separate scoped service identities with recorded attribution. See [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

**GitHub/demo/voice:** reuse existing summaries and outputs, with generation and rendering on the requesting member's local worker. Record the requesting member, execution owner, source runs, and output synchronization state. External publication remains an explicit, authorized, audited action. A hosted publisher needs its own scoped integration, such as a GitHub App, rather than ambient credentials from a developer's shell. Voice API credentials and spend limits must be explicit where that mode requires separately billed access; native text generation and speech credentials remain separate choices.

## Deployment and operations

Initial footprint: an independently deployed Node checker API, its web frontend, a dedicated Clerk application, a dedicated managed PostgreSQL database, private object storage, and a local worker on each developer machine. The frontend can be served through the same public origin while retaining a separate build. A maintenance process handles lease reconciliation, artifact cleanup, auth synchronization, and publication retries; it may use the backend image with a separate command. Verification and demo workloads execute on local workers; hosted services handle coordination, storage, and sharing. Deployment requires no changes to a target application's backend.

Before team launch, implement:

- TLS and a configured canonical public URL; secure proxy handling and origin rules for login, APIs, events, and links.
- Separate staging/production configuration, databases, buckets, and secrets; versioned migrations with a rollback/forward-fix procedure.
- Separate Clerk development/production instances and approved domains; keep Clerk backend keys and webhook signing secrets on the hosted backend. Verify the selected plan's required features before launch.
- Database backups and a demonstrated restore; object retention and a recovery policy consistent with database references.
- Health/readiness checks, graceful API shutdown, worker draining, and protocol version compatibility during deployment.
- Structured logs and traces keyed by organization/run/attempt, secret redaction, error reporting, and alerts for queue age, lost workers, failed uploads, and database failures.
- Per-member/team concurrency and usage budgets, request rate limits, upload limits, and retention controls. Report unknown subscription cost as unknown rather than zero.
- Shared UI for sign-in, invitations, role changes, active devices, worker status, authorized provider selection, run ownership, live progress, filters, and stable evidence links.

Actual hosting size and cost should follow observed run volume, video retention, and concurrency. A hosting product choice is not necessary to establish these boundaries.

## Migration and delivery sequence

Treat migration as a controlled import of existing checker data, not ongoing dual writes. Snapshot the checker's JSON stores, case/version data, and run artifacts. Product-backend databases and user tables are outside this migration. Preserve legacy IDs, session memberships, revisions, archive/tombstone state, provenance, and unknown values. Mark historical creators unknown where evidence is missing; do not attribute every old run to the importer.

Import metadata into a seeded organization mapped to the approved Clerk organization, upload retained artifacts, verify counts/references/checksums, and map local repositories and provider instances to their owning workers. Native credential homes and target browser sessions are not migrated into the shared database. Freeze local writes for final cutover, then make the hosted database authoritative for checker domain data; Clerk remains the login-session authority. Keep the original snapshot for rollback/read-only comparison.

| Milestone | Reviewable result |
| --- | --- |
| 1. Independent backend and identity | Standalone checker API/deployment, dedicated database, Clerk invite-only login and session controls, local authorization/audit records, correct member/test-account attribution, authenticated staging |
| 2. One local worker and shared run | Enrollment, owner-bound claims, one existing case, shared progress and a private report |
| 3. Local demos and shared artifacts | Local recording/narration/rendering, recoverable uploads, team playback with the producer offline |
| 4. Recovery and synchronization | Durable local journals, disconnect/restart handling, concurrency locks, stale-lease rejection, cancellation acknowledgement |
| 5. Team workflow | Shared history, environment grants, worker onboarding, UI/local MCP parity, audited publication/demo ownership |
| 6. Migration and rollout | Controlled import, backup/restore proof, two members on two workers, supported-OS installation, operational limits |
| Later | Hosted HTTP MCP, additional organizations, deeper project-level permissions, optional personas; central execution would require a new architecture decision |

See the [delivery roadmap and decision register](team-web-roadmap.md) for dependencies, completion checks, proposed defaults, and choices to settle before each milestone.

The first end-to-end slice should be: invite a teammate → sign in → register their local worker → run one existing case and generate a demo locally → observe shared progress → upload private evidence → disconnect the developer machine → another teammate watches the uploaded demo → revoke access. Complete this before expanding administrative UI or adding more auth methods.

Launch checks must demonstrate denied cross-member execution and cross-organization resource access, revoked login/MCP access, private artifact access, restart survival, test-account locking across two workers, stale-lease rejection, and no automatic replay of uncertain writes. Verify local demo execution, interrupted/resumed uploads without duplicate outputs, accurate disconnected-worker status, and team playback after the producing machine shuts down. Also verify importer reconciliation and retained compatibility with existing local verification behavior.

Verify backend independence by running checker sign-in, session/history browsing, and uploaded-artifact playback while a target backend is unavailable. The checker deployment must require neither target-backend database credentials nor imports of its application modules.

This work supplies the foundation for backlog member attribution, concurrent-environment presentation, and environment write permissions. Backend-derived mocking and personas consume these foundations without blocking the initial team pilot. This proposal does not change backlog statuses or start an implementation session.
