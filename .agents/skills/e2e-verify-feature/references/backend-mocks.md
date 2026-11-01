# Optional backend-derived mock runs

Read this only after selecting mocked frontend coverage. Use the normal case, frontend target, provider/account/model, session, job, and evidence workflow in `SKILL.md`. `mockSuite` on `verify_case` or `verify_cases` enables this mode; `get_setup({coverage:"mocked", ...})` only scopes readiness checks. Omitting `mockSuite` preserves live verification.

## Supply the relevant contract

Locate the backend checkout through the application's configuration or documentation. For a migration pending in staging, use the backend worktree containing the intended API implementation, model/schema changes, and relevant migration; a migration file alone rarely defines the response contract. Do not infer response fields from the frontend or the deployed staging version.

Select only the routes, handlers/services, validators, permission logic, data schemas, and state transitions needed by the case. Resolve relevant imports during this selection. The checker author can read only the supplied files, so include dependencies that materially explain the response. Use an absolute `backendRoot` and paths relative to it for `sourceFiles` and `schemaFiles`. Optional `frontendFiles` are relative to the selected local frontend worktree and help with selectors; omit them for a hosted target. Paths must be accessible to the checker process and stay inside their explicit roots; traversal and escaping symlinks are rejected.

Supply JSON-encoded JSON Schema (draft-07 or 2020-12), or an OpenAPI JSON document from which the author can select a schema pointer. Bundle cross-file/remote references; only local fragment references are resolved, and unsupported dialects/keywords fail validation. Include TypeScript/Zod/ORM definitions in `sourceFiles` as evidence; they are not executed as validators. If no machine-readable schema exists, `schemaFiles:[]` is accepted. Each derived response must then record `unavailableContract`; disclose the missing validation and contract assumptions. Do not fabricate a schema and present it as an existing backend contract. Optional `mockSuite.expectedRevision` requires the exact backend Git HEAD; content hashes also capture uncommitted source changes.

Ensure the case specifies observable success behavior and the relevant error, empty, permission, or boundary expectations before submission. The suite format requires a success scenario and coverage of every case step; assertions must quote the case's expected results. Backend source defines realistic responses; acceptance criteria define correct frontend behavior. If necessary source or expected behavior is unavailable, report the gap and obtain the missing input rather than inventing it.

## Submit through the existing MCP tools

Add this field to the ordinary `verify_case` input, replacing paths and URL rules with evidence from the target application. The selected checker provider derives the fixtures and assertions; the caller does not need to hand-author mock responses.

```json
{
  "mockSuite": {
    "backendRoot": "/work/backend-feature",
    "sourceFiles": ["src/routes/invoices.ts", "src/services/invoices.ts", "src/models/invoice.ts"],
    "schemaFiles": ["schemas/invoice.json", "schemas/error.json"],
    "frontendFiles": ["src/Invoice.tsx"],
    "allowedLiveRequests": [
      {"method":"GET","url":"/invoices","resourceTypes":["document"],"reason":"Frontend entry page"},
      {"method":"GET","url":"/assets/*","resourceTypes":["script","stylesheet","font","image"],"reason":"Frontend assets"}
    ]
  }
}
```

Select `worktreePath` for the actual frontend feature, or omit it for a configured hosted frontend. Backend and frontend roots are independent. With `verify_cases`, group only cases that share the supplied source scope and allowed live requests. Use a separate submission for live integration coverage.

`allowedLiveRequests` is the caller's explicit list of requests that may reach servers. Derive it from the actual frontend entry routes, assets, and intentional dependencies; avoid broad API allowances to work around missing mocks. Match method, URL and resource type. Relative URLs resolve against the frontend origin; use absolute URLs for external dependencies. Only a final `*` has prefix semantics. Live redirects are rejected. Dev-server hot reload may need a separate rule using an HTTP(S)/relative URL, `method:"GET"`, and `resourceTypes:["websocket"]`.

Mocks match method, origin/path, exact query parameters (including repeated values), and exact JSON/text body. Response sequences are finite and consumed once in order. Unlisted traffic, mismatched inputs, unexpected extra calls, and unconsumed responses fail the suite; live allowances cannot bypass a mocked endpoint.

Each scenario starts with empty cookies, local storage, and IndexedDB; live login is skipped and service workers are blocked. Selecting `userId` does not seed authentication. Required authentication must be part of the mocked browser flow. Browser interception does not cover server-side rendering or requests made by a frontend server, so this mode cannot establish that those requests avoided the real backend or database.

The declarative flow supports navigation, click/fill/press/check/select, and visible/hidden/text/value/count/URL assertions. Auth seeds, arbitrary JavaScript, direct API test calls, file uploads, streaming/binary responses, and WebSocket mocking are unsupported. Read [the supported operations and network policy](../../../../docs/backend-mock-suites.md) when these limits affect the case; do not claim coverage for an unsupported path.

## Interpret results and choose replay or reauthoring

Use `wait_jobs` and `get_job` as usual. Check `coverage:"mocked"`, the overall outcome, and every scenario's status. Preserve failures; neither weaken acceptance criteria nor broaden live allowances merely to make a run pass. A migration-related report should say that the frontend handled responses derived from the pending backend contract, and that migration execution/database behavior remains unverified.

Retrieve `get_evidence({jobId,artifact:"mock-suite"})` for fixtures, scenarios, and assertions; use `artifact:"mock-sources"` for captured files, hashes, and revision, and `artifact:"results"` for current scenario results, alongside the usual video/trace links. Check that the assertions reflect the case's expectations; schema validation cannot establish semantic fidelity to acceptance prose. Report allowed live dependencies and missing schema validation when they limit the conclusion. Read artifact excerpts only as needed.

Use `replay_job({jobId})` to rerun the same saved response scenarios without model calls. Replay retains the historical case/source/fixtures; it does not reread the current backend. To verify compatibility with the current case, relevant source/schema files, and mock inputs, submit `verify_case`/`verify_cases` again. A compatible suite produces fresh replay evidence without authoring; changed relevant inputs invalidate reuse, and `forceFresh:true` explicitly requests new authoring. After a frontend-only fix, replay can check the unchanged suite on its original target; use new verification for a different target. A queued `SOURCE_CHANGED` result requires a new submission after confirming the intended source state.

Do not edit stored fixture/spec artifacts or weaken assertions to force a pass. After the first `try_spec` execution, only locator repairs are allowed. If the case or supplied contract needs correction, correct that input and submit again; an unchanged failing suite remains evidence of failure.
