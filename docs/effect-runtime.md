# Effect runtime

The backend uses Effect 4 for verification orchestration, dependency injection, scoped resources, cancellation, deadlines and bounded concurrency. The HTTP and MCP contracts, saved job format, provider subscription authentication and browser UI are unchanged.

## Composition

Functions ending in `Effect` return lazy programs. They compose with `Effect.gen` and receive dependencies through `Context.Service`. `CheckerLive` supplies the production layers:

| Service | Responsibility |
| --- | --- |
| `ProcessRunner` | Execute commands and clean up process groups |
| `CredentialStore` | Resolve environment and 1Password references inside the harness |
| `ProviderRegistry` | Inspect subscription authentication and available models |
| `PricingCatalog` | Load the catalog used to pin run pricing |
| `QaseSource` | Read external cases through a scoped MCP connection |
| `CaseRepository` / `EnvironmentRepository` | Expose local storage operations without changing atomic write or revision semantics |

Tests can substitute individual services with `Effect.provideService`; the verification fixture exercises the orchestration and usage accounting without calling a model. Promise facades preserve existing callers. Only those boundaries run the composed effects.

## Resource ownership and cancellation

Commands, login browsers, Codex RPC connections and stage MCP clients register finalizers before initialization proceeds. Interruption runs cleanup before returning. Command cleanup sends SIGTERM to the process group, gives it a bounded grace period, then sends SIGKILL. Codex also requests interruption of an active remote turn. Stage-tool scopes cancel and join in-flight SDK callbacks.

The scheduler owns an Effect fiber per active job. Cancellation waits for resource cleanup before final job bookkeeping completes. Shutdown stops scheduling, marks queued jobs interrupted, interrupts active fibers and waits for their finalizers. A submission that was already checking a provider cannot enqueue jobs after shutdown begins. Stage metrics are retained on failure and interruption.

Effect deadlines replace command, RPC and run timeout races. Semaphores serialize batch submission, slot allocation and stage-tool calls. Effect concurrency handles independent readiness and credential lookups; failure cancels sibling work. Provider and pricing catalogs use Effect caches with bounded TTLs.

HTTP requests are interrupted when the caller disconnects. Long-running HTTP and stdio MCP entry points use `runMain` to translate SIGINT/SIGTERM into interruption; stdio servers also handle input EOF. Detached frontend development servers intentionally outlive individual verification runs so slots remain reusable.

## Boundaries

Node streams, Playwright and MCP SDK callbacks remain native APIs, adapted with `sdk` or `Effect.callback`. Adapters pass cancellation signals when supported. Filesystem transactions and pure transforms remain synchronous. Zod continues to validate public HTTP/MCP inputs; Effect does not change wire schemas or expose credential values. Token counting and price calculations keep their existing provider and tokentally sources.

Use native effects when composing backend work. Add a service when an external dependency needs substitution or a resource has an independent lifetime. Keep `runEffect` at Promise-facing entry points, and use `Effect.acquireRelease` to register cleanup before a fallible initialization step.

## Validation

`npm test` covers process termination, resource release on timeout, credential sibling cancellation, failed RPC initialization, cancelled browser MCP initialization, injected verification, shutdown races, storage and API/MCP contracts. See [the test guide](../tests/README.md) for real localhost browser/network and environment-login smoke tests. These checks do not establish live provider execution or subscription billing accuracy.
