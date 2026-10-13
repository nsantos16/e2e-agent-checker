# Checker MCP contract for selectable runtimes

> Current implementation: [Agent MCP v0.6](agent-mcp.md), including local case CRUD, Qase refresh, compact responses, waits, evidence and browser frames.
>
> Historical design baseline. See [implemented scope and verification](runtime-milestone.md) for current behavior, the T3-style UI, and the Cursor capability gate. Tables below describe the pre-implementation audit or proposed contract.

Date: 2026-10-12. Status: proposed; not the current server implementation. See [next milestone](next-milestone.md) for the selected subscription-first direction and implementation order.

## Boundary

One local stdio MCP server is installable in Claude Code, Codex and Cursor. The caller's runtime and the verification job's runtime are independent. A Codex caller can submit a Cursor verification job. Credentials stay with the selected native runtime; the checker returns only readiness, model and usage information.

Keep stdio as the compatibility baseline. The UI and MCP call the same job service and use the same schemas. Each tool advertises an input and output schema, returns machine-readable `structuredContent` plus concise text, and uses `isError` for operational tool errors. The current server uses `@modelcontextprotocol/sdk`; extend that existing integration rather than building another MCP transport. [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

An asynchronous job ID remains the baseline. MCP Tasks may be added behind capability negotiation later; not every client supports the same task extension. Cancelling an already-returned submission call is not cancelling its background job, so `cancel_job` must remain explicit. [MCP Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks).

## Public tools

| Tool             | Input                                                         | Result / behavior                                                                                                           |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `list_providers` | none                                                          | Installed runtime/version, effective auth mode/readiness, capability flags and official login instructions; no token values |
| `list_models`    | provider, optional cursor                                     | Account/runtime catalog with IDs, reasoning options and discovery time; no inferred entitlements                            |
| `list_cases`     | project, query, optional cursor                               | Case IDs, titles, steps and available fixture requirements                                                                  |
| `list_worktrees` | none                                                          | Known worktrees, commit, dirty state and running slot; this is discoverability, not arbitrary filesystem access             |
| `verify_case`    | Existing fields + optional target, limits and idempotency key | One queued job ID; existing callers retain the configured default                                                           |
| `verify_cases`   | Cases, worktree, targets, limits, idempotency key             | Comparison group ID and one job ID per case × target                                                                        |
| `get_job`        | job ID, optional event cursor                                 | Status, stage, result, normalized usage/timing, artifact manifest and a bounded event page                                  |
| `list_jobs`      | Optional status/provider/worktree/group filters and cursor    | Bounded summaries, next cursor; no full transcripts                                                                         |
| `cancel_job`     | job ID                                                        | Idempotent cancellation request and current state; success does not claim cleanup completed until it has                    |
| `replay_job`     | source job ID, optional worktree, idempotency key             | New replay job using a saved spec; zero model calls; missing artifact is an error                                           |
| `attach_to_pr`   | job ID, full PR URL, idempotency key                          | Explicit evidence publication, returning the posted comment URL                                                             |

`list_worktrees` subsumes the user-facing need described as `list_slots` in older docs. If a slot-debugging tool is still needed, add it deliberately and test that it is registered. Do not document unregistered tools.

Login is initiated by the user through the connection UI or provider's native terminal flow. `list_providers` supplies the supported next action when logged out. There is no generic `set_oauth_token` tool and no password/token returned to a model. MCP authentication for a future hosted checker would be a separate requirement from agent-provider authentication.

## Submission example

Illustrative IDs must be replaced with discovered model IDs. This is a proposed request, not a working command against the current server:

```json
{
  "worktreePath": "/absolute/path/to/frontend-worktree",
  "cases": [{ "project": "DEMO", "id": 6003 }],
  "targets": [
    { "provider": "claude-code", "model": "sonnet", "authMode": "subscription" },
    { "provider": "codex", "model": "<discovered-codex-model>", "authMode": "subscription" },
    { "provider": "cursor", "model": "<discovered-cursor-model>", "authMode": "subscription" }
  ],
  "limits": { "timeoutMs": 900000, "maxAttempts": 4 },
  "idempotencyKey": "local-comparison-6003-001"
}
```

Limits are per child job unless explicitly named as group limits. Validate every target/case and fan-out limit before atomically accepting the group. Persist the normalized request with its idempotency key: same key + same request returns existing IDs; same key + different request returns `IDEMPOTENCY_CONFLICT`. Queue scheduling additionally respects provider concurrency/rate limits and test-identity leases.

Before launching an agent, persist the selected model and effective authentication mode. Check installation, login/mode, required tools, worktree identity, role/fixture readiness and limits. An unavailable model returns a specific error; no automatic paid-key or model fallback is permitted in subscription-only mode.

## Job lifecycle and result

```ts
type JobStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

type Stage = 'prepare' | 'explore' | 'codify' | 'replay' | 'package';
type Verdict = 'pass' | 'fail' | 'blocked';

type VerificationResult = {
  verdict: Verdict;
  steps: Array<{
    position: number;
    verdict: Verdict;
    evidence: string;
    observed: boolean;
  }>;
  replayStatus: 'passed' | 'failed' | 'not-run' | 'error';
};
```

A test finding a product bug is a completed job with a fail verdict. A broken runner is a failed job; a missing fixture can produce a completed, blocked verification report. A completed job does not imply passing verification. Schema validation must require every case step exactly once and reject unknown positions or unsupported verdicts. A generated test must retain expected results when adjusting waits/locators; changed assertions must be surfaced rather than silently healed.

`get_job` includes `schemaVersion`, requested and resolved targets, runtime version, auth mode, case/build/prompt fingerprints, timestamps, per-stage timings/usage, metric completeness and typed errors. Usage remains available for failed/cancelled jobs. Report status is separate from evidence completeness and cleanup status.

Errors use stable codes such as `PROVIDER_UNAVAILABLE`, `AUTH_REQUIRED`, `AUTH_MODE_MISMATCH`, `MODEL_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `FIXTURE_UNAVAILABLE`, `RATE_LIMITED`, `TIMEOUT`, `BUDGET_EXCEEDED`, `REPORT_INVALID`, `ARTIFACT_MISSING` and `IDEMPOTENCY_CONFLICT`. Include a retryable flag and concrete next action. Store sanitized detail; do not include credential-bearing child environments or raw auth responses.

## Runtime adapter

```ts
interface AgentRunner {
  inspect(): Promise<ProviderStatus>;
  listModels(cursor?: string): Promise<ModelPage>;
  run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
```

The named types above are proposed shared schemas, not existing exports. `AgentRunInput` contains a prompt, target, cwd, scoped tool policy, MCP endpoints and limits. Events cover session identity, model resolution, tool activity, text/result, usage snapshots and terminal outcome. Native transcript formats stay inside each adapter. An adapter's capability record distinguishes unsupported, unknown and verified features; UI labels and validation follow that record.

Use one agent session per stage attempt so retries and cumulative metrics can be attributed unambiguously. A reuse/resume path must store its usage baseline and inherited context provenance. The browser action recorder is independent of provider message formats and supplies equivalent codification inputs to every runner.

For ACP, pin stable protocol/SDK versions, advertise only implemented client capabilities, and explicitly handle permission requests. Cursor-specific blocking requests require a bounded response; reject unsupported actions clearly. Never auto-approve arbitrary shell/file tools just because the browser server is approved. If restrictions equivalent to the existing Claude runner cannot be enforced, mark that adapter unavailable for the stage until isolation is implemented.

## Cancellation and recovery

- Queued cancellation removes the queue item and persists a terminal state.
- Running cancellation signals the active stage, interrupts the provider, ends child processes and owned browser sessions, records partial usage and finishes bounded cleanup. Shared dev servers remain while other jobs use them.
- Time/attempt/token limits stop new work through the same cancellation path. Dollar estimates are advisory if pricing/usage is incomplete; native hard limits are used only when supported. Explain potential in-flight overshoot.
- On restart, reconcile persisted jobs against owned processes; never leave a job displaying running after its process was lost. Mark interrupted attempts and preserve metrics. Retry as a new attempt from a validated boundary rather than continuing arbitrary half-finished UI actions.
- Do not retry a mutating stage automatically until its fixture cleanup/idempotency is established.

## Artifacts and compatibility tests

Return an allowlisted artifact manifest with stable IDs, type, size and local resource URI; avoid full transcripts in normal tool output. Canonicalize artifact paths before access. Raw traces remain local; publication accepts only the job's finished approved report/video artifacts. Resolve a full PR URL, and deduplicate publication retries using a persisted publication ID/comment URL.

The same tool schemas must work from Claude Code, Codex and Cursor as callers. Run a contract test using a real MCP SDK client, followed by one smoke invocation from each installed client. Separately test each selected worker runtime; a compatible caller does not prove the selected worker adapter works.

Acceptance cases: successful run, known product failure, blocked fixture, partial usage on crash, cancellation, malformed output, missing token telemetry, invalid target, duplicate group submission, reused-spec replay, expired login, API-key mismatch in subscription-only mode, and a callback/tool request outside the configured permission policy. Add a targeted regression for playback during live metric updates.
