<img src="assets/icon.svg" width="64" height="64" alt="">

# e2e-agent-checker

Proof of concept: an agent verifies **local or Qase test cases** against **any git worktree** of the Sample frontend, turns what it did into a **Playwright spec**, replays that spec deterministically with **video**, and hands back evidence a coding agent can attach to a PR. It runs in parallel across worktrees and is exposed over **MCP**.

```
verify_case(worktree, DEMO-6003)
  ├─ slot      serve the worktree on its own port against the shared dev API, log the test user in (1Password)
  ├─ explore   Selected runtime + Playwright MCP execute the Qase steps, report pass/fail/blocked per step with evidence
  ├─ codify    The selected runtime writes a Playwright spec from the explore run and stabilises it (it may only run that spec)
  ├─ replay    plain `playwright test` with captions per Qase step, video and trace, no LLM
  └─ package   MP4 (≈1 MB/min) + PR comment with the step table
```

Design and decisions: [docs/architecture-proposals.md](docs/architecture-proposals.md), [ADRs](docs/adr/), results: [docs/poc-results.md](docs/poc-results.md).

Design baseline: [run metrics and selectable runtimes](docs/next-milestone.md), [subscription authentication research](docs/research/multi-provider-auth.md), and the [MCP contract](docs/mcp-contract.md).

Live browser and request diagnostics: [docs/browser-observability.md](docs/browser-observability.md).

Implementation status and verified limitations: [docs/runtime-milestone.md](docs/runtime-milestone.md).

## Quick start (any dev)

```sh
git clone <this repo> && cd e2e-agent-checker
npm run setup        # installs deps + browsers, then runs the readiness check
npm run app          # opens http://localhost:4100
```

In the app: pick the **worktree** you want to test (every worktree of your `sample-frontend` checkout is listed, e.g. the one an agent just implemented a ticket in), select one or more **provider models**, then click **Run ▶** or select several cases. Every case × model gets its own run. Open a running job to watch its live browser preview and inspect captured network requests. The agent receives failure summaries and can query detailed diagnostics. Runs show queue/stage timing, input/output/cache tokens, reported cost when available, per-step verdicts, and replay video. Cancel active runs or replay a saved spec without new model calls. Runs sharing a test identity are serialized. Use **+** beside the Cases/Runs tabs to import a Qase case. Subscription login and readiness live in **Connections** in the sidebar; model selection lives in the bottom composer.

`npm run doctor` tells you exactly what's missing. You need:

| What                                             | Why                                              | Fix                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Node ≥ 24                                        | runs the TypeScript directly                     | the frontend already pins 26                                                                           |
| `sample-frontend` checkout                | the app under test                               | found automatically in common locations, or set `frontendRepo` in `e2e-agent.local.json`               |
| Codex CLI or Claude Code CLI, subscription login | runs on your existing subscription               | `codex login` or `claude auth login`; API-key mode is rejected                                         |
| 1Password CLI + `example-team` account            | test-user credentials (never shown to the agent) | `brew install 1password-cli`, enable CLI integration in 1Password → Settings → Developer               |
| Qase API token                                   | optional Qase import/sync                                 | create at app.qase.io/user/api/token → `security add-generic-password -s qase-api-token -a "$USER" -w` |
| ffmpeg                                           | MP4 packaging                                    | `brew install ffmpeg`                                                                                  |
| gh ≥ 2.99 (optional)                             | publishing evidence to a PR                      | `brew install gh && gh auth login`                                                                     |

Per-dev overrides go in `e2e-agent.local.json` (gitignored), e.g. `{ "frontendRepo": "~/work/sample-frontend", "app": { "maxParallel": 2 } }`. Team defaults: `e2e-agent.config.json`.

## Use it from Claude Code, Codex, or Cursor (MCP)

```sh
codex mcp add e2e-agent-checker -- node /Users/nico/.t3/projects/e2e-agent-checker/src/mcp-server.ts
claude mcp add e2e-agent-checker --scope user -- node /Users/nico/.t3/projects/e2e-agent-checker/src/mcp-server.ts
```

Use your checkout's absolute path. The [agent MCP guide](docs/agent-mcp.md) includes Cursor configuration, all 22 tools, exact inputs, compact defaults and compatibility changes.

The normal agent workflow is **discover → verify → wait → inspect only relevant evidence**:

- `get_setup`, searchable `list_cases` / `list_worktrees`, and `list_models` provide readiness and valid inputs. `import_case` / `get_case` make case setup available without the UI.
- Native case CRUD, conflict-aware Qase refresh and run snapshots are available through MCP. See [case management and QA roadmap](docs/case-management.md).
- `verify_case` / `verify_cases` return IDs and direct viewer links; stable idempotency keys prevent duplicate submissions.
- `wait_jobs` waits for a batch in one call and returns only changed summaries when revisions are provided. `get_job` / `list_jobs` return compact status, outcomes, timing and usage.
- `get_evidence` provides artifact links and bounded pages of logs, reports, specs or comments. `get_network` returns five failures by default; request individual sanitized bodies only when needed.
- `get_browser_frame` returns the current image on demand and suppresses unchanged frames. The human watches the browser and video at the returned `viewerUrl`.
- `cancel_job` cancels work; `replay_job` reuses the saved spec without model calls; `attach_to_pr` publishes only on explicit request.

The server includes workflow instructions and tool annotations. Normal status polling omits logs, reports, images and response bodies. Across seven saved runs, compact responses were 92% smaller in JSON bytes; this is not an exact token measurement.

Caller and worker are independent: Cursor can start a Codex verification through this MCP. Cursor as a worker remains gated because its native ACP runtime cannot be configured with verified tool isolation. Example target: `{"provider":"codex","model":"<id from list_models>","authMode":"subscription"}`. There is no API-key fallback or credential-copying service. Dollar cost remains unavailable without a reliable source; token counts are not a billing record.

## Use it from the shell

```sh
node src/slots.ts start --slot 1 --worktree ~/work/sample-frontend-e2e-slot1   # serve a worktree on :4001
node src/login.ts --slot 1 --base http://localhost:4001                                 # session for that origin
node src/explore.ts --case 3949 --slot 1                                                # explore only
npm run verify -- --case 6003 --slot 1 --provider codex --model MODEL_ID                               # full pipeline, replay on 2 builds
node src/batch.ts   --cases 2359,6004,6914 --slots 1,3 --pipeline verify               # many cases, parallel slots
node src/slots.ts list
```

Artifacts land in `runs/<timestamp>-<case>-slot<n>-<label>/`: `explore/` (prompt, transcript, report, action log, raw video), `codify/` (spec, attempts), `replay-slot<n>/` (results, trace, `verification.mp4`), `summary.json`, `pr-comment.md`. Generated specs: `e2e/generated/<run>/`.

Leftover data from interrupted runs: `E2E_SPEC_DIR=$PWD/e2e/sweep ... npx playwright test -c e2e/playwright.config.ts notes.sweep` deletes `e2e-agent-*` notes.

## Safety

- The LLM never sees credentials: login happens in the harness and the agent gets a preloaded session.
- Claude uses its native restricted CLI; Codex uses App Server with native action tools, inherited MCP servers, apps, and delegation disabled. Both use scoped stage tools: browser actions for explore; allowlisted inputs, one spec file, and bounded test attempts for codify. Generated tests execute locally, so use trusted cases and projects.
- Agents only create data named `e2e-agent-*` and clean it up; generated specs clean up in a non-failing `cleanup()` step.
- `trace.zip` files contain typed values and stay local; only the MP4 and the comment are ever published, and only via `attach_to_pr`.

## Checks

```sh
npm test
npm run check
# Opt-in live test: consumes subscription allowance, uses a disposable local page
node tests/provider-smoke.ts --provider codex --model MODEL_ID
node tests/provider-smoke.ts --provider codex --model MODEL_ID --broken
```

The browser playback regression is documented in [tests/README.md](tests/README.md).
