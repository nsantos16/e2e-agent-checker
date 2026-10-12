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

## Requirements

- Node ≥ 24 (runs `.ts` directly), `ffmpeg`, `gh` ≥ 2.99 (for `--attach`), `claude` CLI
- 1Password CLI signed in to `example-team` (test-user credentials, [ADR-0002](docs/adr/0002-1password-service-account-for-test-credentials.md))
- Qase MCP server as `~/.local/bin/qase-mcp` (token in the macOS Keychain, service `qase-api-token`)
- A `sample-frontend` checkout at `~/work/sample-frontend`

```sh
npm install
npx playwright install chromium
npx -y @playwright/mcp@0.0.83 install-browser chromium
```

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
