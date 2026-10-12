# e2e-agent-checker: architecture proposals

Status: draft for discussion · 2026-10-12

Decisions so far:
- [ADR-0001: Playwright MCP is the browser driver for the proof of concept](adr/0001-playwright-mcp-as-poc-browser-driver.md)
- [ADR-0002: Test credentials come from a 1Password service account, resolved by the harness](adr/0002-1password-service-account-for-test-credentials.md)
- [ADR-0003: PoC worktrees run the frontend locally against the shared dev backend, isolated by pool user](adr/0003-frontend-worktrees-against-shared-dev-backend.md)

## Goal

Given a ticket (description, user stories, context) and a git worktree, an agent drives Chrome against that worktree's running app, verifies each user story end to end, and produces:

1. a video of the verification, ready to attach to the PR description
2. a pass/fail report for each user story
3. (ideally) a deterministic e2e test file the developer can commit

It must run **in parallel across worktrees** and be callable **over MCP**, so a coding agent finishing a PR can ask for "verify + video" and get back something it can attach.

## The four decisions that shape every option

### 1. Control surface: the OS or the browser

| | OS-level computer use (screenshots + mouse/keyboard) | Browser-level (CDP / Playwright, accessibility snapshot) |
|---|---|---|
| Parallelism on one Mac | **No.** There is one cursor and one screen, so it needs a VM or container per run | **Yes.** N headless browser contexts, each fully isolated |
| Speed and token cost | Slow, since every step costs a screenshot | Fast, because the a11y tree is text and screenshots are optional |
| Reliability | Pixel targeting, flaky | Semantic refs and roles, fairly robust |
| Reach | Anything: native dialogs, extensions, other apps | Web content only |
| Output as code | Hard | Natural, since actions map 1:1 to Playwright calls |

**Implication:** the stated main goal (parallel worktrees, video in the PR) points strongly at browser-level control. OS-level computer use is still worth exploring as a separate research track, but it should not be the core of the PoC.

#### 1b. Which browser driver, and where the tokens actually go

Full evidence: [research/browser-driver-benchmarks.md](research/browser-driver-benchmarks.md).

The engine (Playwright vs raw CDP) barely matters. In the only independent benchmark that ran every driver through the same harness (WebdriverIO, Claude Sonnet 5, live Online-Mind2Web tasks):

| Setup | Cost/task | Success | Tool calls |
|---|---|---|---|
| playwright-mcp / tuned | $0.177 / $0.165 | 32% / 36% | 16 / 14 |
| stagehand | $0.216 | 60% | 26 |
| wdio-mcp | $0.107 | 52% | 18.5 |
| agent-browser | $0.355 | 48% | 32.5 |
| playwright-cli | $0.259 | 40% | 26.5 |

What we learn from it:
- **Smaller snapshots do not make a task cheaper.** agent-browser, marketed as using "~90% fewer tokens", was the *most* expensive, because it needed 2× the turns and every turn re-sends the conversation.
- **CLI vs MCP makes no reliable difference** (confirmed separately by Checkly). The "4× cheaper" claim doesn't reproduce.
- **Turns are what drives cost.** Success differences are mostly within the ±10–14 pt confidence intervals, so they count as ties.
- The accessibility tree is the right default observation. Screenshots add tokens and often lower success (WebMall). Use them on demand only.
- **Caveats:** WebdriverIO runs the benchmark and its own tools came out cheapest. The tasks are live websites, not our local app.

**Position:** use Playwright MCP as the PoC's explore driver. It's middle of the pack on cost, and it shares an engine with replay. Its per-action codegen also feeds the codify step. Keep the driver behind an interface, and pick the final one with **our own benchmark** (Spike 0b) on real tickets. The bigger savings come from the architecture: fewer turns per story, and Explore → Codify → Replay so that re-verification costs zero tokens.

### 2. Who drives: the calling agent or an embedded agent

- **Caller-driven:** Claude Code (or any MCP client) receives browser primitives and drives them itself. Very little to build, but it uses up the caller's context, parallelism depends on the caller spawning subagents, and every run behaves a little differently.
- **Embedded:** the MCP server exposes *job-level* tools (`verify_ticket`, `get_job`). Each job runs its own agent loop (Claude Agent SDK) in the background. The caller fires a job and polls, so the caller's context stays clean and parallelism is ours to control.

### 3. What the video shows: the agent exploring, or a replay

Recording the agent while it explores gives you a video with think-pauses, retries and dead ends. It's honest, but painful to watch in a PR. The alternative is to **let the agent explore, have it write a Playwright spec, then run that spec deterministically with video on**. That gives a short, clean video and a test you can commit and re-run without an LLM.

### 4. Per-worktree environment isolation

Most of the real difficulty lives here rather than in the AI part. Each worktree needs:
- its own app instance on a **unique port** (and any services it depends on: API, DB, queues)
- data isolation: a separate DB/schema, seeded per run, or a shared read-only seed
- an auth strategy: a seeded test user plus Playwright `storageState`
- a project-level config describing how to boot it, for example:

```jsonc
// e2e-agent.config.json (committed in the target repo)
{
  "start": "pnpm dev --port $PORT",
  "healthcheck": "http://localhost:$PORT/health",
  "env": { "DATABASE_URL": "postgres://localhost/app_$WORKTREE_SLUG" },
  "setup": "pnpm db:reset && pnpm db:seed",
  "baseURL": "http://localhost:$PORT",
  "auth": { "storageStateScript": "e2e/auth.setup.ts" }
}
```

Alternatively, run one `docker compose -p <worktree-slug>` project per worktree, which isolates ports and data for free when the app is already containerised.

### Delivery: getting the video into the PR

Since **gh v2.99.0 (Sept 2026)**, `gh pr create|edit|comment --attach <file>` uploads MP4/MOV/WebM and inlines it in the body. Limits: videos of 10 MB on Free plans and 100 MB on paid plans. GitHub Enterprise Server is not supported, and you need write access. **Caveat:** user-attachment URLs can be viewed without auth, even on private repos. That might be unacceptable for internal apps; if so, the fallback is a private bucket (S3/R2) plus a signed or SSO-protected link.

Practical pipeline: Playwright `.webm` → `ffmpeg` to H.264 MP4, capped at about 1280×720 and trimmed/sped up → `gh pr edit --attach`.

---

## Proposal A: "Thin MCP" (caller-driven, off-the-shelf)

```
Claude Code (per worktree, or one session + N subagents)
   ├── Playwright MCP  (--isolated --headless --save-video=1280x720, one instance per worktree)
   └── gh CLI          (attach video)
Worktree app started manually / by a script on $PORT
```

- **Build:** almost nothing. A skill/prompt template ("given this ticket, verify each story, then attach the video") and a script that boots each worktree on its own port.
- **Pros:** validates the idea in a day; you learn where agents fail on *your* app before investing.
- **Cons:** the video is the raw exploration. Runs aren't reproducible. Parallelism and cleanup are left to the caller. `--save-video` has open bugs in some setups (it conflicts with `--extension`, and there are browser-install errors).
- **Use as:** Spike 0, the baseline every other option has to beat.

## Proposal B: Orchestrator MCP with an embedded agent

```
            MCP client (Claude Code / Cursor / CI)
                         │  verify_ticket, get_job, list_jobs, cancel_job
                         ▼
┌──────────────────── e2e-agent daemon (MCP server, long-lived) ────────────────────┐
│ Job queue (concurrency N)                                                          │
│   ├─ Ticket adapter     text / Linear / GitHub issue  →  normalized UserStory[]    │
│   ├─ Env manager        worktree → port alloc → setup → start → healthcheck → stop │
│   ├─ Browser pool       1 Chromium, N isolated contexts (recordVideo, tracing)     │
│   ├─ Agent runner       Claude Agent SDK loop, tools = browser actions + assert    │
│   └─ Artifact store     ~/.e2e-agent/runs/<id>/{video.mp4, trace.zip, report.json} │
└────────────────────────────────────────────────────────────────────────────────────┘
```

MCP surface (job-oriented, async):

| Tool | Returns |
|---|---|
| `verify_ticket({ worktreePath, ticket, stories?, context? })` | `{ jobId }` immediately |
| `get_job({ jobId })` | status, per-story verdicts, artifact paths |
| `attach_to_pr({ jobId, pr })` | runs ffmpeg + `gh pr edit --attach` |
| `list_jobs()` / `cancel_job()` | |

- **Pros:** real parallelism under our control; the caller's context stays clean; one place to handle ports, cleanup, retries and cost limits; works from any MCP client and from CI.
- **Cons:** we own an agent loop and a daemon. The video is still exploration footage unless combined with C.

## Proposal C: Explore → Codify → Replay (recommended core)

This is B's orchestration with a better pipeline inside each job:

```
 1. EXPLORE   agent + live browser (no video, trace only)
              for each user story: find the path, confirm the expected outcome
 2. CODIFY    agent emits e2e/<ticket>/<story>.spec.ts using what it saw
              (stable locators: getByRole/getByLabel/getByTestId; web-first assertions)
 3. REPLAY    plain `playwright test` with video:'on', trace:'on', slowMo≈250ms
              → deterministic, short, watchable video per story
 4. HEAL      on failure: feed error + trace back to agent → patch spec → replay
              (max K attempts; then report "story failed" with evidence = a real finding)
 5. PACKAGE   concat story videos (+ title cards) → mp4 → report.json → attach
```

- Playwright ships planner/generator/healer test agents (since v1.56, `npx playwright init-agents`). We can **reuse their prompts and approach** for steps 1, 2 and 4 rather than inventing our own.
- **Pros:** clean PR videos; a committed regression test as a by-product; re-verifying after a code change costs no LLM tokens unless the spec breaks; a failing replay is *evidence* rather than agent noise.
- **Cons:** the codify step can produce brittle specs (hardcoded data, bad waits), which needs conventions and fixtures. It needs good auth and seed-data stories in the target app. Two phases mean slower first runs.
- **Key distinction:** step 4 has to separate "my spec is wrong" from "the feature is broken". Otherwise the healer will happily "fix" the test until it passes against a bug. Mitigations: assertions are derived from the user story *before* exploring, and the healer may change locators and waits but not expected values without flagging it.

## Proposal D: Full computer use in containers (research track)

```
per run: docker container [Xvfb + Chrome + ffmpeg x11grab + agent loop]
         ↕ host.docker.internal:$PORT  → worktree app on host
Claude computer-use tool (screenshot / click / type)
```

- This fits the "learn how agents control a computer" research goal best, and it's the only option that handles things a browser API can't reach (native file pickers, OS dialogs, browser extensions, desktop apps).
- **Pros:** fully general; the recording is just a screen capture of the virtual display.
- **Cons:** you need one container per parallel run (Anthropic's reference demo runs a single session per container). It's slow and screenshot-heavy, so it costs a lot of tokens. Pixel-level actions are flaky, nothing comes out as reusable test code, and on macOS hosts the networking and dev-server access add friction.
- **Use as:** a time-boxed spike that compares the same ticket on D vs C (success rate, wall time, tokens, video quality).

### Variant: remote browsers

Any of B, C or D can swap the local browser pool for a hosted one (Browserbase, Steel, etc.) to scale beyond one laptop. It needs a tunnel to local worktrees, or preview deployments. That's out of scope for the PoC, but the browser pool should sit behind an interface so it can be swapped later.

---

## Comparison

| | A Thin MCP | B Orchestrator | **C Explore→Codify→Replay** | D Computer use |
|---|---|---|---|---|
| Effort to PoC | ~1 day | ~1–2 weeks | ~2–3 weeks (B + pipeline) | ~1–2 weeks spike |
| Parallel worktrees | caller-managed | ✅ | ✅ | ✅ (container each, heavy) |
| Video quality for PR | poor (exploration) | poor–ok | **good (deterministic replay)** | poor–ok |
| Reproducible / reusable test | ❌ | ❌ | **✅ committed spec** | ❌ |
| Token cost per re-run | high | high | **~0 if spec still passes** | very high |
| Handles non-web UI | ❌ | ❌ | ❌ | ✅ |
| Teaches "computer control" | some | some | some | **most** |

## Recommendation

Build **C on top of B's daemon**, reached at first through **A**:

1. **Spike 0 (A), 1–2 days.** Run Claude Code + Playwright MCP on two worktrees of one real app with one real ticket. Write down every failure: boot, auth, data, selectors, video.
   **Spike 0b, 2–3 days.** Fork the `webdriverio/benchmark` harness, replace its tasks with 10–20 of our user stories against a local worktree, and compare playwright-mcp (default and tuned), playwright-cli, agent-browser, stagehand and wdio-mcp. Measure cost, turns, verdict correctness and whether each trace can be codified, with 3 runs each.
2. **M1: Env manager + MCP skeleton.** Worktree → port → boot → healthcheck → teardown; `verify_ticket`/`get_job` with a stubbed agent. Prove that N worktrees can run in parallel cleanly. *This is where the risk is.*
3. **M2: Explore + Codify + Replay** for a single story, with video output.
4. **M3: Healer + multiple stories + packaging** (concat, mp4, report) + `attach_to_pr`.
5. **M4 (parallel research track): D spike** on the same ticket set, for comparison.

Suggested stack: TypeScript, `@modelcontextprotocol/sdk`, an explore driver behind an interface (Playwright MCP by default, final choice from Spike 0b), `@playwright/test` + `playwright` for replay (contexts, video, tracing), the Claude Agent SDK for the loop (Opus 5.5 for explore/heal, possibly Sonnet/Haiku 5.5 for cheap codify retries), ffmpeg, gh ≥ 2.99.

## Open questions

1. **Target app(s):** what do they look like? Single web app, monorepo, docker-compose? How long does a cold boot take? This determines the env manager.
2. **Data and auth:** is there a seed script and a test user? Can each worktree get its own DB?
3. **Ticket source:** free text first, or Linear from day one?
4. **Video privacy:** are public-by-URL GitHub attachments acceptable for these repos, or do we need a private bucket?
5. **Generated specs:** should they be committed to the target repo (they become regression tests), or kept as throwaway artifacts?
6. **Where it runs:** only on the developer's laptop, or should the same daemon run in CI later?

## Sources

- Playwright test agents (planner/generator/healer): https://bug0.com/blog/playwright-test-agents, https://testdino.com/blog/playwright-ai-ecosystem-2026
- Playwright MCP `--save-video` issues: https://github.com/microsoft/playwright-mcp/issues/1093, https://github.com/microsoft/playwright-mcp/issues/1134
- gh `--attach` for PR media: https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments
- GitHub attachment limits and visibility: https://docs.github.com/en/enterprise-server@3.15/get-started/writing-on-github/working-with-advanced-formatting/attaching-files
- MCP vs CLI token measurement: https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/
- Playwright CLI vs MCP claims: https://bug0.com/blog/playwright-cli-vs-playwright-mcp-ai-browser-testing-2026, https://shipyard.build/blog/playwright-mcp-vs-cli/
- Vercel agent-browser: https://github.com/vercel-labs/agent-browser
- dev-browser: https://www.skills.sh/sawyerhood/dev-browser/dev-browser
- Stagehand caching: https://docs.stagehand.dev/v4/best-practices/caching
- Opera snapshot compression (dense pages >100k tokens): https://operaneon.com/news/token-efficient-browser-snapshots-for-opera-browser-cli
- Chrome DevTools MCP `--isolated`: https://addyosmani.com/blog/devtools-mcp/
- Claude computer use tool: https://platform.claude.com/docs/de/agents-and-tools/tool-use/computer-use-tool
