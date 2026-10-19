# Product backlog

Resume list for another agent. Each item is a request, not current behavior. Read the linked docs and code before changing anything. Leave an item here until it is implemented.

## 1. Remove side-pane items

Recorded 2026-10-19.

The side pane (`src/app/client/components/Sidebar.tsx`) lists cases and runs. Selecting a run opens it in the workspace. There is no control to remove a run from that list. Cases can be archived through MCP `delete_case`; the pane has no remove control for a case either.

**Request:** Remove a run from the side pane. The same remove action applies to every element listed there, including cases and runs.

**Read:** `src/app/client/components/Sidebar.tsx`, `src/app/client/workspace.ts`, `src/jobs.ts`, `src/cases.ts`, [case management](case-management.md).

## 2. Prove backend changes with request e2e

Recorded 2026-10-19.

A verification drives the frontend in a browser. A local run serves a frontend worktree, and that frontend's mode file chooses the API, often the shared development backend. A hosted run uses a deployed URL. Captured network traffic is diagnostic evidence beside the browser replay. The checker does not run backend-request e2e that passes or fails a backend change on its own.

[ADR-0003](adr/0003-frontend-worktrees-against-shared-dev-backend.md) and [target app](target-app.md) describe `yarn local-workspace` for worktrees that change the backend. [PoC results](poc-results.md) record that path as unfinished, so the backend regression pair DEMO-6915 was not run against a local backend.

**Request:** Run e2e checks of backend requests so a backend change can be proved, alongside the frontend checks that exist today.

**Read:** `src/slots.ts`, [environments](environments.md), [browser and network evidence](browser-observability.md), [ADR-0003](adr/0003-frontend-worktrees-against-shared-dev-backend.md), [PoC results](poc-results.md).

## 3. Session summary for a pull request

Recorded 2026-10-19.

A finished run writes `runs/<id>/pr-comment.md` from `prComment()` in `src/verify.ts`: a per-case step table, replay status, and video path. `attach_to_pr` posts that one job's comment and can attach that job's MP4. There is no tool or endpoint that summarizes a session of runs into one pull-request explanation of the demo and its videos.

**Request:** Add an MCP tool or endpoint that returns the pull-request summary for the session. Use it to publish, and to generate one standard format for how demos and videos from this tool are explained.

**Read:** `prComment` in `src/verify.ts`, `attach_to_pr` in `src/mcp-server.ts`, [agent MCP](agent-mcp.md), [MCP contract](mcp-contract.md).

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
