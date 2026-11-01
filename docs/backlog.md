# Product backlog

Open product requests are listed first, with their original item numbers preserved. Move implemented requests to the completed section with links to the shipped behavior and validation. Read the linked docs and current code before starting work; historical design proposals are not implementation contracts.

## 2. Prove backend changes with request e2e

Recorded 2026-10-19.

A verification drives the frontend in a browser. A local run serves a frontend worktree, and that frontend's mode file chooses the API, often the shared development backend. A hosted run uses a deployed URL. Captured network traffic is diagnostic evidence beside the browser replay. The checker does not run backend-request e2e that passes or fails a backend change on its own.

[ADR-0003](adr/0003-frontend-worktrees-against-shared-dev-backend.md) and [target app](target-app.md) describe `yarn local-workspace` for worktrees that change the backend. [PoC results](poc-results.md) record that path as unfinished, so the backend regression pair DEMO-6915 was not run against a local backend.

**Request:** Run e2e checks of backend requests so a backend change can be proved, alongside the frontend checks that exist today.

**Read:** `src/slots.ts`, [environments](environments.md), [browser and network evidence](browser-observability.md), [ADR-0003](adr/0003-frontend-worktrees-against-shared-dev-backend.md), [PoC results](poc-results.md).

## 4. Track each run by the team member who started it

Recorded 2026-10-19.

Jobs record the case, target, environment, and test user. The test user is the account that logs into the app under test. The checker does not record which person started the run. MCP tools do not take a caller identity. There is no organization setting that lists team members.

**Request:** Let an organization track each run by the team member who is running it, including the pull-request session summary. Add a setting for that organization's team members. Every MCP tool indicates who is running the call, using a member from that setting.

**Read:** `src/mcp-server.ts`, `src/jobs.ts`, [environments](environments.md), [agent MCP](agent-mcp.md), [MCP contract](mcp-contract.md).

## 5. Show several environments working at the same time

Recorded 2026-10-19.

The composer (`src/app/client/components/Composer.tsx`) selects one environment. A run card shows that environment's name and test user. Several runs can be in progress, and each stores its own environment, but the UI does not explain which environments are active together or how they differ. Comparing backend changes against the same frontend version has no presentation of its own.

**Request:** Check how the UI communicates different environments working at the same time. Make it clear when multiple environments are in use, including a comparison of backend changes on the same frontend version.

**Read:** `src/app/client/components/Composer.tsx`, `src/app/client/components/JobCard.tsx`, `src/app/client/workspace.ts`, [environments](environments.md).

## 6. Per-environment write permissions

Recorded 2026-10-19.

An environment is a hosted URL or a local worktree. Settings store its name, target, mode, and test users. They do not store whether that environment allows write operations. MCP tools and the verification worker do not tell the caller that a chosen environment forbids writes, and they do not confirm a write with the person who invoked the operation.

**Request:** Give each environment its own write permission in settings. When the setting disallows writes, as with production, MCP and the other tools say that this environment does not allow write operations. Check that step with the user who invoked the operation.

**Read:** [environments](environments.md), `src/environments.ts`, `src/app/client/components/Settings.tsx`, `src/mcp-server.ts`, `src/jobs.ts`.

## Completed requests

### 3. Session summary for a pull request and optional voice demos

Shipped on `main` on 2026-11-01 in [afecea5](https://github.com/nsantos16/e2e-agent-checker/commit/afecea525e94fa1d48a37b5d722e5908df2ca943).

- Stable batch/session membership and explicit cross-batch collections; standardized summaries include outcomes, environment/build context, recorded evidence, demos, failures and limitations. MCP, HTTP and the UI share generation and retrieval. Publication remains explicit and deduplicated.
- Persisted, default-off Voice narration settings and per-demo overrides use the same backend schema in MCP and the UI. Bounded subscription text generation and a separate Realtime speech integration produce synchronized MP4/audio/caption artifacts, with caching, cancellation and separate usage. Original silent evidence and test outcomes are retained.
- Settings and composer spacing work across the tested desktop/mobile widths. Archive/deletion semantics preserve session history, and cache cleanup protects active demo generation.
- Real local Kokoro, Piper and Chatterbox Nano samples and timing measurements were delivered. These open-source engines remain benchmarked alternatives, not selectable app providers; see the [comparison and artifact locations](research/local-voice-samples.md).

Validation at the shipped revision: 148 automated tests, TypeScript checks, production build, UI/API smoke, playback/workspace regressions, and real browser/FFmpeg observation and stabilization smoke checks passed. Native narration workers and Realtime transport were covered with fixtures; live credentialed narration and real PR publication remain unverified. See [session summaries and voice demos](session-demos.md) for setup, API/MCP usage, budgets and limitations.
