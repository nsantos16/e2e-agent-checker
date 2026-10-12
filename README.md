<img src="assets/icon.svg" width="64" height="64" alt="">

# e2e-agent-checker

Proof of concept: an agent verifies **Qase test cases** against **any git worktree** of the Sample frontend, turns what it did into a **Playwright spec**, replays that spec deterministically with **video**, and hands back evidence a coding agent can attach to a PR. It runs in parallel across worktrees and is exposed over **MCP**.

```
verify_case(worktree, DEMO-6003)
  ├─ slot      serve the worktree on its own port against the shared dev API, log the test user in (1Password)
  ├─ explore   Claude + Playwright MCP execute the Qase steps, report pass/fail/blocked per step with evidence
  ├─ codify    Claude writes a Playwright spec from the explore run and stabilises it (it may only run that spec)
  ├─ replay    plain `playwright test` with captions per Qase step, video and trace, no LLM
  └─ package   MP4 (≈1 MB/min) + PR comment with the step table
```

Design and decisions: [docs/architecture-proposals.md](docs/architecture-proposals.md), [ADRs](docs/adr/), results: [docs/poc-results.md](docs/poc-results.md).

## Quick start (any dev)

```sh
git clone <this repo> && cd e2e-agent-checker
npm run setup        # installs deps + browsers, then runs the readiness check
npm run app          # opens http://localhost:4100
```

In the app: pick the **worktree** you want to test (every worktree of your `sample-frontend` checkout is listed, e.g. the one an agent just implemented a ticket in), then click **Run ▶** on a use case, or tick several and press **Run N in parallel**. Each run shows its pipeline (slot → explore → codify → replay), per-step verdicts, cost, and the replay video when it finishes. Use **Add** to pull any Qase case by id.

`npm run doctor` tells you exactly what's missing. You need:

| What | Why | Fix |
|---|---|---|
| Node ≥ 24 | runs the TypeScript directly | the frontend already pins 26 |
| `sample-frontend` checkout | the app under test | found automatically in common locations, or set `frontendRepo` in `e2e-agent.local.json` |
| Claude Code CLI, logged in | runs the agents on **your** Claude account | `npm i -g @anthropic-ai/claude-code && claude` |
| 1Password CLI + `example-team` account | test-user credentials (never shown to the agent) | `brew install 1password-cli`, enable CLI integration in 1Password → Settings → Developer |
| Qase API token | reads test cases | create at app.qase.io/user/api/token → `security add-generic-password -s qase-api-token -a "$USER" -w` |
| ffmpeg | MP4 packaging | `brew install ffmpeg` |
| gh ≥ 2.99 (optional) | publishing evidence to a PR | `brew install gh && gh auth login` |

Per-dev overrides go in `e2e-agent.local.json` (gitignored), e.g. `{ "frontendRepo": "~/work/sample-frontend", "app": { "maxParallel": 2 } }`. Team defaults: `e2e-agent.config.json`.

## Use it from Claude Code (MCP)

```sh
claude mcp add e2e-agent-checker --scope user -- node /Users/nico/.t3/projects/e2e-agent-checker/src/mcp-server.ts
```

| Tool | What it does |
|---|---|
| `verify_case({ worktreePath, qaseCaseId, project?, role? })` | Starts a background job, returns `jobId` |
| `get_job({ jobId })` | Stage, per-step verdicts + evidence, replay result, MP4 path, PR comment path, cost |
| `list_jobs()` / `list_slots()` | What's running where |
| `attach_to_pr({ jobId, pr })` | **Publishes**: posts the PR comment and uploads the MP4 with `gh pr comment --attach` |

## Use it from the shell

```sh
node src/slots.ts start --slot 1 --worktree ~/work/sample-frontend-e2e-slot1   # serve a worktree on :4001
node src/login.ts --slot 1 --base http://localhost:4001                                 # session for that origin
node src/explore.ts --case 3949 --slot 1                                                # explore only
node src/verify.ts  --case 6003 --slot 1 --replay-slots 2                               # full pipeline, replay on 2 builds
node src/batch.ts   --cases 2359,6004,6914 --slots 1,3 --pipeline verify               # many cases, parallel slots
node src/slots.ts list
```

Artifacts land in `runs/<timestamp>-<case>-slot<n>-<label>/`: `explore/` (prompt, transcript, report, action log, raw video), `codify/` (spec, attempts), `replay-slot<n>/` (results, trace, `verification.mp4`), `summary.json`, `pr-comment.md`. Generated specs: `e2e/generated/<run>/`.

Leftover data from interrupted runs: `E2E_SPEC_DIR=$PWD/e2e/sweep ... npx playwright test -c e2e/playwright.config.ts notes.sweep` deletes `e2e-agent-*` notes.

## Safety

- The LLM never sees credentials: login happens in the harness and the agent gets a preloaded session.
- Child agents run `claude -p --restricted --permission-mode dontAsk`: explore can only use Playwright MCP; codify can only read/write its spec directory and run `scripts/try-spec.sh`.
- Agents only create data named `e2e-agent-*` and clean it up; generated specs clean up in a non-failing `cleanup()` step.
- `trace.zip` files contain typed values and stay local; only the MP4 and the comment are ever published, and only via `attach_to_pr`.
