# Team web architecture

Status: independent checker backend and local-execution/shared-storage split confirmed by the user; implementation remains proposed. Prepared 2026-11-01 against `origin/main` at `1c3c5c59225804765cbd7c099caf36064dd5e1a3`. The working checkout is older; this audit used the main revision explicitly.

## Selected architecture

Keep the checker's existing React/Vite UI and Node/Effect verification pipeline. Build a standalone checker backend with its own PostgreSQL database, authentication, and private object storage, and separate execution into authenticated local workers. References to the existing codebase mean `e2e-agent-checker`, not the backend of an application being tested.

Confirmed requirement: worktrees, verification, and demo generation execute locally on each developer's machine; status and artifacts are available in a shared team space. Central execution is outside the selected scope. Invite-only access for one internal organization remains the proposed admission policy. Hosting provider and identity provider remain open choices.

### Independent backend boundary

The checker is a standalone product with its own API, user and organization records, login sessions, job coordination, database migrations, storage permissions, configuration, and deployment lifecycle. Its backend is independently deployable from its web UI and local workers; those components can remain in this checker's repository with explicit API/protocol contracts.

The application being tested is an external target. Local workers interact with its existing UI/API using configured test accounts. Backend-derived mocking can inspect explicitly supplied source code and schemas on the developer machine; it does not require installing checker routes, libraries, or database tables in the target backend. Target-specific behavior belongs in configuration or optional worker adapters, not imports of business-backend services into the hosted checker.

Checker authentication and authorization use checker-owned records and sessions. An optional Google/GitHub/Microsoft sign-in uses a separately registered checker identity application. Reusing an identity provider does not reuse the product backend's login endpoints, cookies, authorization logic, or database.

Use dedicated checker deployment resources, database credentials, and artifact storage permissions. Hosting may be chosen independently. The shared checker can serve sign-in, history, and uploaded evidence even when a target backend is unavailable; only work requiring that target should report its unavailability.

The hosted service owns identity, permissions, shared cases, job requests, history, and evidence access. Local workers own repository worktrees, browser execution, native provider processes, target-app login, demo recording, narration orchestration, and media assembly. They connect outward to the service over HTTPS; teammates do not expose their laptop's HTTP server to the internet.

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

## Identity, login, and permissions

Choose Google/GitHub/Microsoft/OIDC sign-in for the independent checker, with invitations controlling admission and a checker-specific identity application. Bind accounts to the provider's stable issuer/subject identity, not an editable display name. Store membership and login sessions in the checker's own database. Disable public signup and self-service organization creation for the pilot. Avoid building password recovery and MFA ourselves; use the identity provider's policies.

**Recommended candidate: Better Auth with PostgreSQL.** Its documented database sessions and organization plugin cover useful foundations: session expiry/revocation, memberships, roles, and invitations. Validate its Node handler, chosen identity provider, migrations, and revocation behavior in a small integration spike before committing to a version. Domain authorization remains our responsibility. Sources: [sessions](https://better-auth.com/docs/concepts/session-management), [organizations](https://better-auth.com/docs/plugins/organization), [PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql), [Node integration](https://better-auth.com/docs/installation).

Keep these concepts distinct:

| Concept | Meaning | Persistence/ownership |
| --- | --- | --- |
| Team member | Person allowed to use the checker | User, external identity, organization membership |
| Login session | One authenticated browser/device | Auth library's session table, expiration and revocation |
| Verification session | Named collection of runs for a feature or PR | Organization-owned session and run memberships |
| Run / attempt | Requested verification and a particular execution | Requesting member, worker, snapshots, status, events, timestamps |
| Provider session | Claude/Codex runtime conversation | External session/turn IDs on an attempt; credentials remain with the runtime |
| Test account | User logged into the application being tested | Environment account metadata and secret references; browser state stays on the worker |

A member's account page should list active login devices and offer sign-out of one or all sessions. Use Secure/HttpOnly cookies, an appropriate SameSite policy, explicit trusted origins, and CSRF protection for cookie-authenticated mutations. Proposed pilot policy: seven-day idle expiry with a separate 30-day absolute limit and recent authentication for sensitive account changes. These are product choices to implement and test, not assumed library defaults.

Keep login-session validation and membership checks authoritative in the database initially. Avoid a cache that permits access after revocation. Removal from the organization invalidates its API/MCP access, closes live streams, disables owned worker grants, prevents new leases, and requests cancellation of affected active work. Remote cancellation cannot undo side effects already performed.

| Role | Initial permissions |
| --- | --- |
| Owner | Admin permissions plus ownership transfer and organization lifecycle |
| Admin | Invite/remove members, configure shared projects/environments, cancel team runs, manage retention |
| Member | Read permitted team evidence, manage cases, submit runs on authorized workers/environments, cancel own runs |
| Viewer | Read permitted cases, history, and evidence |

Use explicit environment/worker grants for execution and publication. Admin status does not expose provider secrets or grant arbitrary access to another person's computer. Start with organization-wide visibility for normal case/run metadata; restrict sensitive evidence and execution separately. Apply the same policy in HTTP, MCP, exports, artifact access, and event streams. Never accept a caller-supplied member ID as the acting identity.

## PostgreSQL model

The following are logical names, not a ready-to-run migration. Use the auth library's actual generated schema for identity/session tables instead of maintaining a parallel implementation.

| Area | Tables and important relationships |
| --- | --- |
| Identity | `users`, `auth_identities`, `auth_sessions`, `organizations`, `memberships`, `invitations` |
| Configuration | `projects`, `environments`, `test_accounts`, `execution_grants`; secret references only |
| Execution inventory | `workers`, `provider_instances`, `workspace_bindings`; member ownership, capabilities, last heartbeat, revocation |
| Cases | `cases`, immutable `case_versions`; stable IDs, revisions, archive/delete state |
| Work | `verification_sessions`, `session_runs`, `runs`, `run_attempts`, `run_events`, `demo_jobs`; demo jobs record requester, worker, source runs, attempts, and progress using the same execution protocol |
| Evidence | `artifacts`, `demo_outputs`, `publications`; object keys, checksums, size, media type, provenance, retention |
| Coordination | `resource_leases`, `idempotency_receipts`; execution and account/workspace concurrency |
| Accountability | `audit_events`, usage records; actor, action, resource, outcome, time |

Every organization-owned row needs `org_id`. Enforce organization-scoped lookups and composite foreign keys so that a run cannot reference another organization's case or artifact. Identity users may be global. Database row-level security can add defense in depth, but only with tested non-bypass database roles and transaction-local tenant context; it does not replace application permissions. See [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

Key relationships and constraints:

- Membership is unique by organization/user. Keep historical actor attribution after a member leaves.
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

**MCP:** keep the stdio adapter for the first team release, with authenticated access to the shared API and the same member permissions as the web UI. A hosted HTTP MCP endpoint can follow separately; it requires an authorization server, protected resource metadata, audience validation, PKCE, and scoped tokens. Browser session cookies alone do not implement remote MCP authorization. CI uses separate scoped service identities with recorded attribution. See [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

**GitHub/demo/voice:** reuse existing summaries and outputs, with generation and rendering on the requesting member's local worker. Record the requesting member, execution owner, source runs, and output synchronization state. External publication remains an explicit, authorized, audited action. A hosted publisher needs its own scoped integration, such as a GitHub App, rather than ambient credentials from a developer's shell. Voice API credentials and spend limits must be explicit where that mode requires separately billed access; native text generation and speech credentials remain separate choices.

## Deployment and operations

Initial footprint: an independently deployed Node checker API, its web frontend, a dedicated managed PostgreSQL database, private object storage, and a local worker on each developer machine. The frontend can be served through the same public origin while retaining a separate build. A maintenance process handles lease reconciliation, artifact cleanup, and publication retries; it may use the backend image with a separate command. Verification and demo workloads execute on local workers; hosted services handle coordination, storage, and sharing. Deployment requires no changes to a target application's backend.

Before team launch, implement:

- TLS and a configured canonical public URL; secure proxy handling and origin rules for login, APIs, events, and links.
- Separate staging/production configuration, databases, buckets, and secrets; versioned migrations with a rollback/forward-fix procedure.
- Database backups and a demonstrated restore; object retention and a recovery policy consistent with database references.
- Health/readiness checks, graceful API shutdown, worker draining, and protocol version compatibility during deployment.
- Structured logs and traces keyed by organization/run/attempt, secret redaction, error reporting, and alerts for queue age, lost workers, failed uploads, and database failures.
- Per-member/team concurrency and usage budgets, request rate limits, upload limits, and retention controls. Report unknown subscription cost as unknown rather than zero.
- Shared UI for sign-in, invitations, role changes, active devices, worker status, authorized provider selection, run ownership, live progress, filters, and stable evidence links.

Actual hosting size and cost should follow observed run volume, video retention, and concurrency. A hosting product choice is not necessary to establish these boundaries.

## Migration and delivery sequence

Treat migration as a controlled import of existing checker data, not ongoing dual writes. Snapshot the checker's JSON stores, case/version data, and run artifacts. Product-backend databases and user tables are outside this migration. Preserve legacy IDs, session memberships, revisions, archive/tombstone state, provenance, and unknown values. Mark historical creators unknown where evidence is missing; do not attribute every old run to the importer.

Import metadata into a seeded organization, upload retained artifacts, verify counts/references/checksums, and map local repositories and provider instances to their owning workers. Native credential homes and target browser sessions are not migrated into the shared database. Freeze local writes for final cutover, then make the hosted database authoritative. Keep the original snapshot for rollback/read-only comparison.

| Milestone | Reviewable result |
| --- | --- |
| 1. Independent backend and identity | Standalone checker API/deployment, dedicated database, invite-only login, devices/revocation, roles, correct member/test-account attribution, authenticated staging |
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
