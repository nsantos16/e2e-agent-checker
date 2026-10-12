---
status: accepted
date: 2026-10-12
---

# Playwright MCP is the browser driver for the proof of concept

For the proof of concept, the agent controls Chrome through Playwright MCP (`@playwright/mcp`). We chose it over `playwright-cli`, Vercel `agent-browser`, Stagehand and WebdriverIO MCP. Blog posts and vendor claims say those alternatives are more token-efficient, but the only independent benchmark that ran every driver through the same harness (WebdriverIO, 2026-10) does not back that up. In that run, Playwright MCP was mid-pack on cost per task. `agent-browser` and `playwright-cli` cost more despite their smaller snapshots, because they needed more turns. Playwright MCP also shares its engine with Playwright Test, which we expect to use for recording and replaying the generated e2e tests. The evidence is in [browser-driver-benchmarks.md](../research/browser-driver-benchmarks.md).

## Considered Options

- **`playwright-cli`**: same backend as the MCP server. Its "~4× fewer tokens" claim did not reproduce: Checkly found about the same tokens, and WebdriverIO found it more expensive.
- **Vercel `agent-browser`**: has the smallest snapshots, but was the most expensive per task ($0.355 vs $0.177 with Claude Sonnet 5) because it made ~2× the tool calls.
- **Stagehand**: had the highest success rate (60% vs 32%), but cost more per task, and its internal model calls may not be counted. Its action cache only works on Browserbase, not with a local browser.
- **WebdriverIO MCP**: the cheapest in that benchmark. The benchmark is published by WebdriverIO itself, and the Claude run used pre-release builds, so we didn't treat its numbers as neutral evidence.

## Consequences

- The driver sits behind an interface so it can be replaced. This decision only covers the proof of concept. Revisit it after we benchmark the drivers on our own tickets against a local worktree (Spike 0b in [architecture-proposals.md](../architecture-proposals.md)).
- Playwright MCP's `--save-video` has open bugs (#1093, #1134). Don't rely on it for the PR video until it's verified in our setup.
