# Browser driver token efficiency: what the benchmarks actually show

Status: research notes · 2026-10-12

Question: for the *explore* phase (an agent driving Chrome to verify user stories), which driver costs the fewest tokens without hurting success?

## TL;DR

1. **A smaller snapshot does not mean a cheaper task.** The tools that advertise "90%+ smaller snapshots" used *more* tokens end to end in the only independent, same-harness benchmark, because they needed more turns. Every turn re-sends the whole conversation.
2. **The claim that a CLI is ~4× cheaper than MCP does not hold up.** In two independent measurements, `playwright-cli` used about the same tokens as Playwright MCP (Checkly), or more (WebdriverIO, with Claude Sonnet 5).
3. **The number of turns and tool calls is the variable that tracks cost.** Per-call payload matters less.
4. **The accessibility tree is the right default observation.** Adding screenshots costs about 9% more tokens and often *lowers* success (WebMall).
5. No public benchmark matches our case: a known local app, known user stories, generating a test. **We need to run our own benchmark**, and an open harness exists that we can reuse.

## Evidence, ranked by trustworthiness

### 1. WebdriverIO browser agent benchmark (independent harness, but run by a competitor)

Source: https://github.com/webdriverio/benchmark (runs from 2026-10-05 and 2026-10-09). The harness is open and MIT-licensed.

- **Setup:** Claude Agent SDK with an identical prompt for every setup. Built-in tools are disabled. Tasks come from Online-Mind2Web (live sites), one run per task, judged by WebJudge (o4-mini, 86% agreement with humans). Tokens include cache reads and writes.
- **Versions:** `@playwright/mcp@0.0.83`, `@playwright/cli@0.1.22`, `agent-browser@0.38.2`, `stagehand@4.1.0`.

**Claude Sonnet 5, 50 tasks (medians per task):**

| Setup | Tokens | Cost | Success | Tool calls |
|---|---|---|---|---|
| playwright-mcp (default) | 363k | $0.177 | 32% | 16 |
| playwright-mcp-tuned (`--snapshot-mode none --codegen none`) | 284k | $0.165 | 36% | 14 |
| stagehand (v4 Claude Code facade) | 549k | $0.216 | **60%** | 26 |
| wdio-mcp | **241k** | **$0.107** | 52% | 18.5 |
| wdio-session (CLI) | 306k | $0.128 | 54% | 20 |
| agent-browser (CLI + skill) | **1116k** | **$0.355** | 48% | 32.5 |
| playwright-cli (CLI + skill) | 680k | $0.259 | 40% | 26.5 |

**DeepSeek V4.1 Flash, 100 tasks:** the ordering is similar. agent-browser is again the most expensive (735k tokens, $0.036), and wdio-session is the cheapest (168k, $0.010). Success ranges from 48% to 58%.

How to read it:
- The success intervals are about ±10 points at 100 tasks, and wider at 50. Most of the success differences are **ties**. The cost differences are large enough to matter.
- Tokens correlate with tool calls: agent-browser makes 2× the calls of Playwright MCP and costs 2× as much.
- **Conflict of interest:** WebdriverIO runs the benchmark, and its own tools come out cheapest. They were also pre-release builds in the Claude run.
- If Stagehand's tools make their own model calls, those tokens are **not** counted, so Stagehand's real cost is understated.
- Live websites with bot walls are a different problem from driving our own app on localhost.

### 2. Checkly: MCP vs CLI (independent, small)

Source: https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/

- Claude Code with one e-commerce task, run three times per setup: Playwright MCP used about 48–50k tokens, `playwright-cli` + skill about 45–48k.
- Why the gap closed: harnesses now load MCP tool schemas on demand, and Playwright MCP writes snapshots to disk and returns a link. The CLI and the MCP server share the same backend.

### 3. Academic: what kind of observation to use

- **WebMall** (arXiv 2508.13024): tokens per task were AX-tree 148k, AX-tree + vision 162k, vision only 120k (GPT-5.4). Adding vision **lowered** completion in most task groups, and vision-only collapsed with a weaker model (Qwen: 0% on most groups).
- **Read More, Think More** (arXiv 2604.01535): heavy pruning isn't always best. Stronger models (and larger thinking budgets) do better with richer HTML, while weaker models do better with compact AX trees. Including history helps, and **diff-based history** is the token-efficient way to do it.
- **Signal-Driven Observation** (arXiv 2606.06708): raw DOM or AX trees are routinely tens of thousands of tokens per step, and BrowserGym pages exceed 20k.

### 4. Vendor and self-reported (treat as marketing)

| Claim | Source | What it actually measured |
|---|---|---|
| Stagehand: 32k tokens vs Playwright MCP 97–105k, 100% vs 75–88% success | Stagehand blog, 2026-09-29 | 8 tasks × 3 runs, Sonnet 5. Internal model calls are possibly not counted. The independent rerun (above) found Stagehand used *more* tokens than Playwright MCP, but with higher success |
| `playwright-cli` "~4× fewer tokens" (114k vs 27k) | Microsoft, repeated in blogs | No published methodology. The README only says "more token-efficient" and gives no numbers |
| agent-browser "~90–93% fewer tokens" | blogs and directories | Snapshot size compared with full AX-tree dumps, not task tokens |
| thinbrowser "43× smaller than Playwright MCP, 25× smaller than agent-browser" | github.com/pgalyen1987/agent-browser | Characters per page representation on 5 live pages. On a full task it was 1.7× cheaper for click-heavy work and **no savings** on form filling |
| OpenBrowser: Playwright MCP 248k vs Chrome DevTools MCP 135k | OpenBrowser docs (a competitor) | 5-step Wikipedia flow, "estimated" tokens |

## What this means for our design

1. **Optimise for fewer turns, not smaller snapshots.** Batch known steps, avoid "snapshot after every action", and stop re-exploring.
2. **Measure cost, not raw tokens.** Cache reads dominate the token count but are billed at a fraction of the price.
3. **The Explore → Codify → Replay split (proposal C) is the biggest lever of all.** Exploring happens once per story, and replay costs zero tokens. The choice of driver is second-order.
4. **The default driver for the PoC is Playwright MCP (default or tuned).** It's middle of the pack on cost, and it shares an engine with our replay step. Its per-action codegen output also feeds the codify step directly. We swap it out only if our own benchmark shows a clear win.
5. Keep the driver behind an interface, so Stagehand (best success in the independent run), wdio-mcp (cheapest) and agent-browser can be benchmarked fairly.

## Our own benchmark (Spike 0b)

Fork the `webdriverio/benchmark` harness and replace Online-Mind2Web with **our** tasks:
- 10–20 user stories from real tickets, run against a local worktree of our app
- setups: playwright-mcp, playwright-mcp-tuned, playwright-cli, agent-browser, stagehand, wdio-mcp
- metrics: cost (USD, cache-aware), turns, wall time, story verdict correctness (we know the ground truth), and **whether the explore trace was good enough to codify into a passing spec**
- 3 runs per story per setup, so the comparison doesn't rest on single runs

## Sources

- WebdriverIO benchmark: https://github.com/webdriverio/benchmark · https://benchmark.webdriver.io
- Checkly, "CLIs are more token-efficient than MCP. Or are they?": https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/
- Stagehand, "Why Playwright MCP uses so many tokens": https://www.stagehand.dev/blog/playwright-mcp-token-usage
- microsoft/playwright-cli README: https://github.com/microsoft/playwright-cli/blob/main/README.md
- thinbrowser benchmark: https://github.com/pgalyen1987/agent-browser
- vercel-labs/agent-browser: https://github.com/vercel-labs/agent-browser
- web-agent-comparison (8-dimension MCP rubric, agent-browser not in the current set): https://github.com/pleasedodisturb/web-agent-comparison
- WebMall: https://arxiv.org/html/2508.13024v3
- Read More, Think More: https://arxiv.org/abs/2604.01535
- Signal-Driven Observation: https://arxiv.org/html/2606.06708
- OpenBrowser comparison: https://docs.openbrowser.me/comparison
