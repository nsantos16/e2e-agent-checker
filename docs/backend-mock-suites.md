# Browser suites derived from backend source

Backlog item #2 implements **mocked frontend coverage**. For a selected case, the authoring provider reads scoped backend implementation/schema files, derives response fixtures and browser assertions, and runs them against the real frontend. Passing proves frontend behavior under those responses. It does **not** execute or prove the backend, database, authorization enforcement, or deployed API contracts.

Select **Run options → Coverage → Backend-derived mocks**, supply the backend directory and relative source/schema paths, and list the requests allowed to reach a server. Select the frontend worktree or hosted environment, case, and provider/account/model as usual. The ordinary live-backend mode remains the default. Run again retains the mode and inputs; Replay retains the original captured source and fixtures.

The repository's [e2e-verify-feature skill](../.agents/skills/e2e-verify-feature/SKILL.md) helps coding agents choose this optional mode for pending backend contracts, controlled errors/data/permissions, response sequences, and repeatable frontend regressions. It keeps live coverage as the default and distinguishes frontend response handling from deployed integration or migration verification.

## Inputs and source inspection

HTTP `POST /api/jobs` and MCP `verify_case` / `verify_cases` accept an optional `mockSuite`. Example MCP input (replace the paths, endpoints and provider with the target's actual configuration):

```json
{
  "project": "LOCAL",
  "caseId": 1,
  "environmentId": "local",
  "userId": "qa",
  "worktreePath": "/work/frontend-feature",
  "target": {
    "provider": "codex",
    "instanceId": "codex-default",
    "model": "MODEL_FROM_LIST_MODELS",
    "options": { "effort": "max" }
  },
  "mockSuite": {
    "backendRoot": "/work/backend-feature",
    "sourceFiles": ["src/routes/invoices.ts", "src/services/invoices.ts", "src/models/invoice.ts"],
    "schemaFiles": ["schemas/invoice.json", "schemas/error.json"],
    "frontendFiles": ["src/Invoice.tsx"],
    "allowedLiveRequests": [
      {"method":"GET","url":"/invoices","resourceTypes":["document"],"reason":"Frontend entry page"},
      {"method":"GET","url":"/assets/*","resourceTypes":["script","stylesheet","font","image"],"reason":"Frontend build assets"}
    ]
  },
  "idempotencyKey": "invoice-mock-suite-1"
}
```

HTTP uses `worktree` in place of MCP's `worktreePath` and takes `cases` and `targets` arrays. A hosted environment supplies the frontend URL instead of a worktree. `get_setup({environmentId,userId,coverage:"mocked"})` excludes live-login credential requirements. Native provider readiness, account/instance snapshots, effort validation, identity serialization, cancellation, time/attempt budgets, session membership and idempotency use the normal workflow.

Locate the actual backend through project configuration/docs before supplying paths. No backend path or contract is inferred from the frontend's name. The caller selects relevant routes, handlers, services, validators, permission logic, data models and state-transition code. The author receives only those files, supplied schemas, optional frontend files and the case; it has no general shell or filesystem tool. Imports outside the selected inputs are unavailable and must be reported as assumptions, or included in a new submission. Frontend files are optional selector evidence and require a local frontend worktree.

Files must be regular files inside the explicit roots; traversal and escaping symlinks are rejected. Limits: 256 KB per file, 2 MB per source bundle, 48 implementation files, 32 schema files and 32 frontend files. Source snapshots retain exact bytes as text, content hashes, original relative paths, canonical backend root and Git HEAD when available. Non-Git source directories are supported with content hashes. Optional `expectedRevision` requires an exact backend HEAD. Relevant inputs are fingerprinted at submission and checked again at execution; queued work fails if they changed. Inputs are copied into the run before authoring and are not reread during replay.

## Authoring and contract validation

The scoped author uses `read_inputs`, `write_mock_suite` and `try_spec`, with the existing bounded evidence/detail tools. The suite records route/validation/permission/transition analysis, source citations for every mock, assumptions and reasons for omitted scenarios. Success coverage is mandatory; relevant errors, empty states, permission and boundary cases are derived from the case and supplied sources. Every case position must be covered. Each scenario step includes an exact quotation from that case step's expected result and at least one observable assertion. The provider interprets that criterion; schema validation cannot prove semantic fidelity to arbitrary prose.

The suite is declarative JSON (up to 12 scenarios / 2 MB), compiled by the checker into a reusable Playwright spec. Supported operations: navigate, click, fill, press, check, select, and assertions for visible/hidden elements, exact text/value/count or URL. Locators support test IDs, roles, text, labels and CSS. Arbitrary JavaScript, direct API test calls, skipped tests and expected-failure annotations are not authoring capabilities.

Response fixtures require either a supplied schema file/JSON pointer or an explicit `unavailableContract` explanation. Optional `requestContract` validates the matched body. AJV validates JSON Schema draft-07 and 2020-12, including local fragment references and formats, without coercion or fetching remote schemas. OpenAPI schema pointers (for example `/components/schemas/Invoice`) retain local component references; unsupported dialect/keywords fail validation. TypeScript/Zod/ORM source can inform derivation but is **not executed** as a validator: report those contracts as unavailable for machine validation. Export a self-contained JSON Schema to obtain machine validation. Cross-file/remote schema references must be bundled. An absent contract is never reported as schema-validated coverage.

Every `try_spec` runs all scenarios. After the first attempt the suite's scenario membership, operations, expected values, request/response fixtures and analysis are locked; only locator repairs are accepted. Wrong expectations or incomplete flows require a fresh submission. Assertion failures stay failed. The final suite must have been tried before authoring completes, and the checker always performs an independent final replay. A failing frontend is a valid completed result, not an invitation to rewrite expectations.

## Network policy and isolation

Each scenario runs in its own Playwright process/context with empty cookies, local storage and IndexedDB. Preparatory live login is skipped, including for worktrees. Cases requiring authentication must drive a mocked authentication flow in the browser. Service workers are blocked. WebSocket mocks and streaming responses are not supported. Unlisted WebSocket connections fail the scenario. For dev-server hot reload, explicitly allow an HTTP(S)/relative URL rule with `method:"GET"` and `resourceTypes:["websocket"]`; the harness maps its scheme to WS(S) and records it as live. For example, `url:"/*"` allows sockets only on the frontend origin (including dynamic HMR query tokens). WebSocket message contents are not captured.

Mock matching includes method, origin/path, exact query multimap (including repeated values) and exact JSON or text body. An omitted body requires no request body. Relative URLs resolve against the selected frontend; absolute API URLs are supported. `responses` is an ordered finite sequence, each consumed exactly once. Extra calls, ambiguous definitions, missing calls and mismatches fail the scenario. All endpoints mentioned anywhere in the suite remain protected in every scenario, regardless of live allowances.

Every other request is blocked unless it matches a **caller-supplied** live rule by method, URL and browser resource type. A final `*` means a literal URL prefix; other glob syntax is not supported. Declare frontend documents/assets and any intentional live dependencies explicitly, with reasons. The author cannot expand this list. Live redirects are rejected so a listed URL cannot silently redirect to an unlisted backend. A broad live allowance is the caller's explicit permission; review it accordingly. Route enforcement covers browser HTTP traffic, not server-side rendering or network calls made by the frontend dev server itself.

## Evidence, reuse and limitations

- `mock/suite.json` contains fixtures, matching rules, scenario steps/assertions and analysis. `mock/sources.json` contains captured source and revision provenance. Both are bounded text artifacts through `get_evidence` (`mock-suite`, `mock-sources`) and downloadable through the normal artifact API.
- Each attempt and final scenario retains Playwright results, video, trace, sanitized `network.json`, explicit mocked/live/unexpected `mock-network.json`, and a DOM snapshot for locator diagnosis. The Network UI uses the normal observation feed. Aggregated `results` includes scenario statuses and traffic dispositions.
- The final MP4 concatenates **all** scenario recordings in order. The trace download is a ZIP containing each scenario's Playwright trace ZIP. Incomplete footage is not replaced with a successful scenario's video. Open the nested trace files separately in Playwright's trace viewer.
- Jobs, run cards, verification reports, PR comment artifacts and session summaries label mocked coverage, list scenario results and preserve assumptions/unavailable contracts. Nothing is published automatically.
- Automatic reuse requires the same case revision/content, relevant source/schema contents, caller inputs/live allowances, environment/user/application requirements and runtime. Fixture/source/spec bytes are integrity-checked together, and the saved spec must exactly match the checker compilation of its suite. Editing a saved fixture invalidates it; change the case/source or use `forceFresh` to author new expectations. Unrelated backend commits/files do not invalidate unchanged supplied contracts (unless `expectedRevision` pins HEAD).
- Explicit replay keeps historical source/fixtures, still checks artifact integrity/runtime, creates fresh evidence and makes no model calls. Replays of replays work. Mocked and live specs are never interchangeable. Existing live histories remain readable.
- Per-scenario step timelines remain available locally. Concatenated suite videos do not yet have a consolidated narration timeline; automatic voice narration of that concatenation is unavailable. Silent replay and session summaries work normally.
- This mode currently needs a browser-rendered frontend and a declarative flow supported by the operations above. Hosted flows without selector evidence may require a fresh iteration after DOM inspection. Authentication seeds, file uploads, arbitrary scripts, binary responses and streaming mocks are not supported.

## Verification

```sh
npm test
npm run check
npm run build
node tests/mock-suite-smoke.ts
```

Unit tests cover source boundaries, schema/type rejection, OpenAPI/2020-12 validation, assertion anchoring/locking, method/query/body matching, and cache separation/invalidation. The API/MCP/UI integration test uses a disposable native-provider protocol peer and frontend, queues a real job, checks idempotency and source/fixture artifacts, verifies session-summary labels, exercises configuration at mobile width, and replays without login or another model turn.

The standalone smoke uses a controlled provider peer that **reads the source through the stage tools** and derives fixture data from the disposable backend implementation. Real Playwright executes a passing success scenario and a failing permission scenario, preserves failure on replay, then passes the unchanged saved suite against a fixed frontend and replays that reuse. It also checks response sequences, exact JSON body matching, rejected methods/queries, unexpected endpoints, browser storage isolation and schema/case/fixture invalidation. It retains MP4s, traces, network results and `measurements.json` under `runs/mock-suite-smoke-*`.

These checks make no live model call and execute no real backend. They verify the authoring protocol, guards, compilation and browser workflow with a deterministic provider fixture; they do not establish how reliably a live model interprets a particular application's source.

The implementation verification passed 157 tests with `node --test --test-concurrency=4 tests/*.test.ts`, plus type checking, production build, 120 existing browser UI checks, and both mock-suite/live saved-spec browser smokes. One simultaneous unrestricted test/smoke run hit native subprocess startup timeouts; the bounded rerun passed unchanged assertions. Retained mock proof: `runs/mock-suite-smoke-KL6ksU/measurements.json` (one controlled provider turn, zero live model calls, zero backend requests). Ordinary live-mode replay proof: `runs/saved-spec-smoke-IGKZ6U/measurements.json` (fixed frontend passes; regressed frontend fails).
