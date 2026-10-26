# Automatic saved-spec reuse

Normal verification looks for a compatible saved spec **after the job acquires its test identity and prepares the requested target**. It executes that spec once through the normal Playwright replay/package path. There is no provider readiness check, pricing lookup, exploration, codification, or model call on this path. Login to the application and preparing its dev server still happen when needed.

Use `forceFresh: true` in `verify_case`, `verify_cases`, or `POST /api/jobs`, `--force-fresh` with `npm run verify`, or **Run options → Saved specs → Force fresh authoring** to author a new spec. Use this for model comparisons. Selected providers/models are authoring choices, not spec compatibility requirements. Fresh authoring may use its qualified current-run stabilization attempt as final evidence; `confirmationReplay: true` separately requires an independent final replay. Automatic saved-spec reuse always executes again and never promotes a historical attempt.

Every submission creates fresh results on its requested target. A reused assertion failure, timeout, or runner error ends that run; it never triggers automatic authoring or assertion changes. Video packaging failure is recorded separately without discarding the test result. Run and replay output directories cannot overwrite previous results.

## Compatibility manifest v1

After fresh authoring produces a pass or fail from a qualified current-run stabilization attempt or an independent final replay, verification atomically publishes `codify/manifest.json`. A missing or outdated stabilization attempt requires replay before publication. Both passing specs and specs that reproduce a failure are eligible. Interrupted authoring or codification ending with `could-not-stabilize` does not publish a manifest.

| Field | Compatibility rule |
| --- | --- |
| `version` | Must be supported (currently `1`); unknown versions fail closed. |
| `case` | Exact project, ID, revision and digest of case content/status/tags. Revisions are checked against the snapshot accepted at submission. |
| `artifacts` | SHA-256 digests of saved spec, case snapshot and exploration report; all three must exist and validate. Old videos/traces are unnecessary. |
| `specContract` | `relative-url-single-file-v1`: relative application URLs; static imports of `@playwright/test` and `../../qase-step` only (optional `.ts`). Literal origins and unsupported/dynamic imports conservatively reject automatic reuse. This check is a portability guard, not a code sandbox. |
| `runtime` | Replay contract version, Node major, installed Playwright/test versions, browser revision metadata, and hashes of the shared helper, Playwright config, observer/network helpers, replay implementation, result reader, attempt qualification and dependency lockfile. |
| `requirements` | Environment ID/revision/kind/dev mode, selected user ID, digest of credential references, and application identity. Hosted origins must match. Worktrees share identity through their common Git directory; their paths/ports/commits may differ. Credential values are never stored. |
| `testedBuild` | **Provenance only, excluded from compatibility.** Target URL, capture time, worktree, commit/dirty state and tracked diff digest when available; optional caller-supplied `buildId`. |

`buildId` is accepted by the verification API/MCP and `--build-id` CLI option. It is useful for hosted deployments, whose commit cannot be inferred by the checker. Dirty provenance records the tracked diff plus a dirty flag; it is not a full snapshot of untracked files. Run provenance is captured at execution start, so external changes during a run are not pinned.

The checker searches the run store, preferring the most recently published compatible artifact. It validates and captures the source bytes together, so subsequent source deletion cannot replace the bytes being executed. Replays are not republished as newly authored specs. No migration silently certifies legacy artifacts.

Missing manifests/artifacts, invalid JSON/schema, unsupported versions, integrity mismatches, changed cases/runtimes/requirements, or nonportable specs fall back to fresh authoring. `specSelection` in job summaries and `summary.json` records `mode`, `reason`, `sourceRun` when used, and up to 20 rejected candidates. The decision is persisted before authoring/provider checks, including when fresh authoring cannot start. `force-fresh` and `no-saved-spec` are explicit reasons too.

## Evidence, usage and compatibility

- `report` resolves to the fresh `verification.json` after execution, with `source` identifying replay or current-run stabilization. Step results come from that execution's recorded steps; missing steps are reported as unrecorded/blocked, never filled from old exploration. `results` exposes the current Playwright report. Video, trace, network capture and browser frames belong to the current run.
- Original exploration is stored under `historical/explore-report.json`, with historical/source metadata. `historical-report` is a separate, labeled API/MCP artifact; its verdict does not determine the current outcome. Replaying a replay retains the original exploration source. PR comments contain fresh results and identify the original exploration as historical.
- `manifest` and `summary` are available through bounded `get_evidence` pages. A reused manifest describes the original authoring; `testedBuild` in the current summary describes this run's target.
- Reuse records complete zero model token usage and zero model execution cost in `usage.json`; subscription billed cost remains unknown. No old stage metrics/pricing are copied into current accounting. Actual prepare/replay/package time is still measured.
- `replay_job` / `--replay-only --from-run` remain explicit replay operations and accept legacy specs without a manifest. They do not automatically fall back to authoring. Historical runs remain readable; old copied exploration from legacy replay jobs is exposed as `historical-report` rather than a current result.
- Case/input validation and idempotent batch acceptance remain atomic. Provider/model readiness now fails an **authoring job at execution time**, rather than rejecting the whole submission. Default request hashes retain compatibility with earlier submissions. Cancellation, shutdown and shared-credential identity serialization remain in place.
- Lookup happens at execution, so queued jobs can reuse a spec just published by the previous job for the same identity. Separate identities can independently author; there is no new global lock or wait for another identity's authoring.

## Verification and measurements

`npm test` covers compatibility decisions, changed cases/content, new commits/worktrees, corrupt/missing artifacts, force-fresh, concurrent/idempotent submissions, identity aliases, deletion while queued, cancellation, legacy replay, fresh failure evidence and zero model/preflight/pricing calls on reuse. `npm run check` checks backend and frontend types.

Measured with controlled provider/process fixtures: fresh verification invokes **2 model stages, 2 provider preflights and 1 pricing load**; compatible reuse invokes **0 of each** and still executes one replay. These are invocation counts, not a benchmark of a live provider's latency or subscription charges.

`node tests/saved-specs-smoke.ts` runs real Playwright against two disposable localhost targets using an explicitly seeded saved-spec fixture. It verifies a fixed build passes, a regressed build fails, only the requested target is visited, and both runs create fresh MP4/trace/network evidence with zero provider calls. It writes actual elapsed times and artifact paths to `runs/saved-spec-smoke-*/measurements.json`.

No live authoring baseline or dollar savings estimate is claimed. Skipping the two model stages removes their work, but total time saved depends on the case, provider, application setup and replay duration.
