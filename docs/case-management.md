# Case management and QA roadmap

The local catalog is the source used for execution. Agents can author cases through MCP without a Qase account. Qase is an optional, read-only import/refresh adapter. New and overridden cases are stored atomically in `.state/cases.json` (gitignored, local to this checkout); existing tracked `fixtures/qase/*.json` are read as legacy records and are never rewritten by CRUD. Back up `.state/cases.json` to move the catalog. This is a single-app local store, not a shared multi-server database.

## MCP operations

| Tool | Behavior |
| --- | --- |
| `create_case` | Creates a native draft; defaults project to `LOCAL`. Server assigns a project-local numeric ID and step positions. Optional `idempotencyKey` prevents duplicate creation. |
| `list_cases` | Compact pages, searchable by ID/title/suite/tags; optional project, status, source and tag filters. Archived cases are excluded unless requested. |
| `get_case` | Full case, steps, source metadata and current revision, including archived records. |
| `update_case` | Partial field update with `expectedRevision`; supplied steps replace the whole list. Set status to `active` or `draft`, or restore an archived case. |
| `delete_case` | Archives with `expectedRevision`; keeps IDs and run evidence. No upstream deletion. |
| `import_case` | Existing Qase import operation. Reuses an existing imported case; does not refresh it. |
| `sync_case` | Imports or refreshes one Qase case from the source. Existing cases require `expectedRevision`. Rejects local content edits and archived records unless `overwriteLocal:true` is explicitly chosen. Tags remain local. No Qase writes. |

Case fields: title, description, preconditions, suite_path, priority, severity, tags, status, and ordered steps with action, expected_result, and optional data. Native cases have no fabricated Qase URL. IDs are stable and never reused after archiving. `caseId` is the preferred argument for reading/running any case; `qaseCaseId` remains a compatible alias. Pass project explicitly for local cases. Request payloads are capped at 64 KB.

Create a runnable case in one call, or omit status/steps to start a draft:

```json
{
  "project": "LOCAL",
  "title": "Saving a note survives reload",
  "status": "active",
  "suite_path": "Notes / Regression",
  "tags": ["smoke", "notes"],
  "preconditions": "Signed in as the configured test user with an editable note",
  "steps": [
    {"action": "Edit the note and save it", "expected_result": "The saved text appears"},
    {"action": "Reload the page", "expected_result": "The same text is still present"}
  ],
  "idempotencyKey": "notes-save-reload-v1"
}
```

Use the returned project/id/revision. Mutation responses contain summaries, not echoed step bodies. Read only when needed, then patch:

```json
{"project":"LOCAL","caseId":1,"expectedRevision":"REVISION_FROM_GET_CASE","changes":{"tags":["smoke","notes","release"]}}
```

On `REVISION_CONFLICT`, read the new version and reconcile your intended edit. Do not overwrite it blindly. On `SYNC_CONFLICT`, review the local version before requesting an explicit source overwrite. A local case using the same project/ID as a Qase case yields `SOURCE_CONFLICT`; using `LOCAL` for native cases avoids that ambiguity. The first sync of a missing Qase case needs no revision; repeated refreshes do.

Drafts cannot run. Activation requires at least one step with both a non-empty action and an expected result. The UI shows drafts, disables their run controls, and refreshes the catalog every five seconds while visible. Authoring is through MCP; the existing UI plus button still imports Qase.

New jobs retain the case snapshot captured at submission. Editing/archiving after queueing does not change those runs. Exploration writes `explore/case.json`; codification reads that same snapshot. `get_job` exposes caseRevision, and `get_evidence({jobId,artifact:"case"})` pages the original case once exploration has started. Replay reuses the prior run's case/spec when available. Old runs without a snapshot remain historical unknowns. Related Qase prerequisites still resolve during exploration; freezing the complete prerequisite graph is future work.

This release has current-record revisions and immutable run snapshots, not a full case revision browser. Sync is explicit and one-way; scheduled sync, batch source reconciliation and other source adapters are future work. Tests cover store persistence, stale writes, archive/restore, sync conflicts, source collisions, real HTTP/MCP CRUD and queued case snapshots. A read-only live fetch of Qase DEMO-6003 verified authentication, transport and case normalization; conflict handling used isolated fixtures. No upstream Qase data was changed and no paid model execution was used.

## Next features, in priority order

1. **Reusable regression plans.** Save named smoke/release/feature case sets with tag selectors and default targets. Run a plan in one MCP call, producing one aggregate result and links to failures. This is the highest-value next step for existing cases. Qase uses [test plans](https://docs.qase.io/en/articles/5563703-test-plans) for repeatable collections too.
2. **Case health and failure triage.** Record recent pass/fail/blocked outcomes per case revision and build, replay stability, last verified date, failure fingerprints, and explicit quarantine with a reason. Distinguish application regressions from environment failures, flaky assertions and outdated expectations. Never silently weaken an assertion to make a run pass.
3. **Draft generation from changes.** Given a PR diff, issue, or acceptance criteria, propose missing positive, negative and permission cases, search for duplicates, then create reviewable drafts with source references. Activation remains an explicit operation; generated coverage is a suggestion until verified.
4. **Cheap reruns before exploration.** Track a saved spec against its case revision and relevant build inputs. Reuse it when valid; request regeneration when the case or assumptions change. Measure pass/fail correctness alongside elapsed time and actual token usage.
5. **Reusable fixtures and parameter sets.** Explicit setup/cleanup, dedicated identities, resettable data, and data-driven roles/browsers/input combinations. This improves repeatability and makes parallel QA safer. [Qase parameters](https://docs.qase.io/en/articles/6640037-test-case-parameters) are a useful model for avoiding duplicated cases.
6. **Broader source sync and traceability.** A source registry for Qase and later issue trackers/files, per-source mapping/cursors, previewable diffs, local override policy, tombstones and conflict resolution. Keep case identity independent of the provider; add external-key mapping before handling multiple sources that share IDs.
