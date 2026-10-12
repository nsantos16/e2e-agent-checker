# Proof of concept plan

Status: draft · 2026-10-12 · Driver: Playwright MCP ([ADR-0001](adr/0001-playwright-mcp-as-poc-browser-driver.md))

## What the PoC must answer

The PoC is done when we can answer these four questions with evidence, not when the code looks nice.

| # | Question | Evidence |
|---|---|---|
| Q1 | Can an agent verify a Qase test case against a local worktree **correctly**? | Verdict matches the known truth on ≥ 80% of selected cases, including at least one case that *should* fail |
| Q2 | Can we turn that into a **watchable video** in a PR? | An MP4 under 10 MB, attached to a draft PR with `gh pr edit --attach` |
| Q3 | Can **two worktrees** run at the same time without interfering? | Two runs in parallel with separate ports, data and browsers, and both verdicts correct |
| Q4 | What does it **cost**? | USD, turns and wall time per case, logged for every run |

Out of scope: hosted service, CI, a UI, Linear integration, auth providers beyond a seeded test user, and choosing the final driver (Spike 0b).

## Input: Qase test cases

Qase cases already have the shape we need, so the "ticket" for the PoC is **one Qase case**:

```
title, description, preconditions
steps[]: { action, expected_result, data }
```

`expected_result` per step becomes the assertion the agent must verify. The agent never invents its own assertions, which keeps it from passing a broken feature (see proposal C's main risk).

### Case selection (6–8 cases)

Selected cases: [poc-cases.md](poc-cases.md).

Pick cases that cover different kinds of difficulty, rather than the ones that are easiest to automate:

| Bucket | Why | Example shape |
|---|---|---|
| A. Read-only navigation + assertion | baseline that should always pass | open page X, filter, expect value Y |
| B. Create/edit with persistence | data dependency, cleanup | create entity, reload, expect it listed |
| C. Multi-step flow, conditional UI | tests reasoning over several pages | wizard / approval flow |
| D. Role- or permission-dependent | tests auth/seed setup | user without permission doesn't see action |
| E. Feature on a branch | the real use case: verify a worktree change | case written for an open ticket |
| F. Known-broken | proves the agent can say **fail** | a case run against a branch with the bug, or a case edited to expect something false |

Avoid in round one: external integrations (bank feeds, accounting sync), emails, file uploads, and anything that needs third-party sandboxes.

## Iterations

Each iteration is small enough for one or two days and produces a demo.

### It-1: one case, one worktree, by hand
- Boot the app from a worktree on a fixed port, with a seeded test user.
- Run Claude Code with Playwright MCP (`--isolated`) using a prompt template: the Qase case as JSON in, a step-by-step verdict + evidence out.
- Output: `runs/<id>/report.json` (a verdict for each step), plus the Playwright code that Playwright MCP generates for each action.
- Learn: where does it get stuck (login, selectors, waiting, data)?

### It-2: codify and replay with video
- The agent turns the explored path into `e2e/qase-<id>.spec.ts`, with locators taken from the snapshot (`getByRole`/`getByLabel`) and assertions taken from `expected_result`.
- Run `playwright test` with `video: 'on'` and `slowMo`, convert to MP4 with ffmpeg, and run `gh pr edit --attach` on a draft PR.
- Q2 answered.

### It-3: all selected cases, plus metrics
- Run the 6–8 cases, 3 runs each. Log cost, turns, time and verdict against ground truth.
- Q1 and Q4 answered.

### It-4: two worktrees in parallel
- A minimal worktree runner: allocate a port, run setup/seed, start, wait for the healthcheck, tear down.
- Run cases in parallel on two branches.
- Q3 answered.

### It-5: wrap as MCP
- `verify_case({ worktreePath, qaseCaseId })` → `{ jobId }`, `get_job`, `attach_to_pr`.
- The first end-to-end demo: Claude Code finishes a PR, calls the tool, and the video appears in the PR.

## Layout of the PoC repo

```
e2e-agent-checker/
  src/
    qase/          fetch case → normalized Case
    worktree/      boot/teardown app per worktree (It-4)
    agent/         prompt templates + Agent SDK loop (Playwright MCP as tool)
    replay/        codified spec runner, video → mp4
    mcp/           MCP server (It-5)
  runs/<id>/       report.json, spec.ts, video.mp4, trace.zip, cost.json
  docs/
```

## Needed from you

1. **Qase access.** Either authorize the Qase connector, or export 6–8 cases (JSON/CSV) into `fixtures/qase/`. Which Qase project?
2. **Target app.** Which repo, and how does it boot locally (command, port, DB, seed, test user)?
3. **Test credentials.** Ask an admin to create a service account (see ADR-0002). Until then we use desktop-app auth with one approval per daemon start ([ADR-0002](adr/0002-1password-service-account-for-test-credentials.md)). In `example.1password.com`: create the `e2e-agent` vault with test users per role, then a read-only service account scoped to it. Store the token with `security add-generic-password -s e2e-agent-op -a service-account -w`.
4. **Known-broken case.** Is there a branch or ticket where a Qase case currently fails, for bucket F?
