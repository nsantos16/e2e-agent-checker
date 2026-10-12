# Multi-provider runners, authentication, and MCP

> Historical design baseline. See [implemented scope and verification](../runtime-milestone.md) for current behavior, the T3-style UI, and the Cursor capability gate. Tables below describe the pre-implementation audit or proposed contract.

Research date: 2026-10-12. Status: proposed architecture; documentation and package metadata verified, no paid agent runs or authentication changes performed.

## Recommendation

Keep the checker’s job API and browser MCP independent of the agent runtime. Implement a small `AgentRunner` contract over the supported native runtimes first, with ACP as an optional transport behind that contract. A common connection screen can normalize provider status and launch each provider’s supported authentication flow; it cannot turn three subscriptions into one shared credential.

**Selected direction:** reuse this user's existing local subscriptions first. Start with unmodified Claude Code `-p`, Codex CLI/App Server, and Cursor CLI/native ACP. Keep each native application responsible for credentials and refresh. Cursor SDK is a later option because its browser flow creates a separate API key rather than adopting the existing CLI login.

Distinguish three selections in persisted runs: **runtime** (`claude-code`, `codex`, `cursor`), **model** (provider-returned identifier), and **authentication/billing mode**. “Claude through Cursor” and “Claude Code” are different experiments, even when the underlying model family is the same. This is an architectural conclusion from the separate runtime interfaces below, not a claim that providers guarantee equivalent behavior.

No reviewed library establishes a supported, universal subscription-login entitlement across all three. ACP is the closest common **agent control protocol**; API gateways unify **model requests**. Neither replaces each provider’s authentication terms.

## Five candidate approaches

| Approach                                                       | What it covers                                                                     | Fit and limitation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Native runtimes behind our adapter — recommended first**  | Claude headless CLI/Agent SDK, Codex SDK/App Server, Cursor CLI/SDK                | Preserves provider-specific model catalogs, permission controls, and usage. We own three narrow adapters and a shared event contract. Sources: [Claude headless](https://code.claude.com/docs/en/headless), [Codex SDK](https://developers.openai.com/codex/sdk), [Cursor CLI](https://cursor.com/docs/cli/reference/parameters).                                                                                                                                                                                                                 |
| **2. ACP SDK plus maintained adapters — best common protocol** | `@agentclientprotocol/sdk`; Claude and Codex adapters; Cursor native ACP           | Authentication remains agent-owned. Use stable ACP v1; v2 is explicitly draft. Capability-negotiate extensions and retain provider-specific telemetry. [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), [authentication](https://agentclientprotocol.com/protocol/v1/authentication).                                                                                                                                                                                                                                 |
| **3. Coder AgentAPI — fallback for terminal-only agents**      | HTTP wrapper for Claude, Codex, Cursor and others                                  | Uses terminal emulation, keystrokes, and output parsing. Good compatibility bridge; weak foundation for precise structured tool/usage accounting. MIT; the maintainers explain that TUI cleanup may need changes when upstream UIs change. [AgentAPI](https://github.com/coder/agentapi).                                                                                                                                                                                                                                                         |
| **4. Pi or OpenCode as one replacement runtime**               | Multi-provider model access and an extensible agent loop                           | Useful if we choose to compare models under our own common harness. Does not reproduce the native Claude/Codex/Cursor agent products. Pi documents OAuth implementations, but implementation is not provider permission. No built-in Cursor runner was established in the reviewed provider catalogs. [Pi](https://github.com/earendil-works/pi), [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md), [OpenCode providers](https://opencode.ai/docs/providers/), [OpenCode SDK](https://opencode.ai/docs/sdk/). |
| **5. Vercel AI SDK / LiteLLM / OpenRouter for model APIs**     | Standardized model calls, provider keys, routing; gateway billing where applicable | A separate future mode for a custom exploration loop. They do not by themselves run the three native coding-agent products or inherit their CLI subscriptions. This is a scope inference from their documented interfaces. [AI SDK](https://ai-sdk.dev/docs/introduction), [LiteLLM](https://docs.litellm.ai/docs/), [OpenRouter](https://openrouter.ai/docs/quickstart).                                                                                                                                                                         |

## Authentication and runtime facts

### Claude Code / Anthropic

The official CLI supports programmatic `claude -p`, JSON/streaming output, model selection, tool controls and session continuation. This gives the existing local checker a native execution path. [Claude headless](https://code.claude.com/docs/en/headless).

Anthropic explicitly preserves an end user signing in to the **unmodified Claude Code binary** with their own subscription, including on a platform hosting that binary under its stated conditions. Separately, it prohibits third-party developers collecting/intermediating Claude.ai credentials or presenting Claude.ai login in their own products; product/SDK integrations are directed to API keys or supported cloud providers. The SDK overview requires approval to offer Claude.ai login/rate limits. Preserve the native binary and native sign-in for this personal-local setup; do not interpret a working OAuth library as permission to proxy credentials. [Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

For a productized shared service, recommend API/cloud credentials. Do not copy subscription tokens into a model gateway, Pi, or a shared worker pool. This recommendation follows the documented boundary; it does not assert that every local use of `claude -p` is prohibited.

### OpenAI Codex

Codex supports ChatGPT subscription sign-in and API-key access. Official guidance recommends API keys for programmatic CLI/CI workflows; current docs also describe enterprise access tokens for eligible trusted automation. The SDK is a coding-agent interface, distinct from calling an OpenAI model API directly. [Codex authentication](https://developers.openai.com/codex/auth), [Codex SDK](https://developers.openai.com/codex/sdk).

App Server supplies supported browser/device login flows, model discovery with account-specific reasoning options (`model/list`), and `thread/tokenUsage/updated`. Keep authentication in Codex using these interfaces; the checker need not read private token files. The capability/schema version should be checked against the installed binary. [App Server](https://developers.openai.com/codex/app-server).

### Cursor

Official CLI docs expose headless `--print`, structured output, `--model`, account model discovery (`agent models` / `--list-models`), and a **hidden** `acp` command. Therefore absence from top-level help does not establish lack of ACP support. The documented JSON output does not establish token-cost completeness. [CLI parameters](https://cursor.com/docs/cli/reference/parameters), [output format](https://cursor.com/docs/cli/reference/output-format).

Local inspection during this task found Cursor CLI `2026.10.01-e373342`; `agent acp --help` succeeds. This verifies command availability, not a completed authenticated ACP session or usage reporting.

Cursor ACP uses `agent acp` over stdio; it can reuse official CLI login/API-key authentication. It supports project/user MCP configuration, not team-level MCP servers. A client must handle permission requests and blocking Cursor extensions such as questions and plan approval. [Cursor ACP](https://cursor.com/docs/cli/acp).

The official TypeScript SDK offers `Cursor.auth.login()` (mints a user API key, not reuse of desktop credentials), account-specific `Cursor.models.list()`, local MCP configuration, and cumulative/per-turn token usage. `Agent.getUsage()` returns billing data, including raw versus charged cents; local availability is account-gated and can return `403 feature_unavailable`. Missing usage is explicitly possible. Its runtime requires Node >=22.13. [Cursor SDK](https://cursor.com/docs/sdk/typescript).

Package metadata checked with `npm view @cursor/sdk version engines license --json`: version **1.0.37**, Node **>=22.13**, license **SEE LICENSE IN LICENSE.md**. This establishes published-package metadata, not successful installation or account access. Review the package license before redistribution; do not assume an MIT license. [npm package](https://www.npmjs.com/package/@cursor/sdk).

## ACP maturity and maintenance

`@agentclientprotocol/claude-agent-acp` wraps the official Claude Agent SDK and supports client MCP servers and permission requests. Its repository is Apache-2.0; the underlying Claude runtime/service has its own terms. [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp).

Use **`@agentclientprotocol/codex-acp`**, not the older Zed package: the former starts Codex App Server, forwards MCP configuration and token-usage events, and advertises ChatGPT/API-key authentication. It includes a compatible Codex dependency. The previous repository explicitly announces the migration. [Current adapter](https://github.com/agentclientprotocol/codex-acp), [migration notice](https://github.com/zed-industries/codex-acp).

ACP provides advertised authentication methods, including agent-driven and terminal flows. It normalizes initiating login, not billing entitlement or provider credentials. Pin the SDK/adapters and test advertised capabilities; protocol extensions and draft v2 can change. [ACP authentication](https://agentclientprotocol.com/protocol/v1/authentication), [SDK stability notice](https://github.com/agentclientprotocol/typescript-sdk).

Pi is MIT and now lives at `earendil-works/pi`; the old `badlogic/pi-mono` repository redirects there. Current packages have the `@earendil-works` scope. Its model abstraction includes provider-owned auth and credential storage, but substituting Pi changes the evaluated agent runtime. [Pi repository](https://github.com/earendil-works/pi), [pi-ai interface](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md).

## Proposed integration boundaries

These are design recommendations, not claims of implemented behavior:

- **Runner contract:** `capabilities`, `authStatus`, `listModels`, `start`, streamed events, `cancel`; optional `beginLogin` and `fetchBilledUsage` only when officially supported.
- **Connection state:** provider, auth mode, readiness/error, supported capabilities and installed version. Keep secrets in provider-owned storage or explicit secret-manager references; never expose them through run reports or MCP responses.
- **Run identity:** persist requested/runtime-resolved model, reasoning setting, runtime version, provider session/turn/request identifiers and comparison-group ID.
- **One checker MCP:** expose job-level verification and retrieval tools. The same server is consumed by Claude, Codex and Cursor; runner selection is an input. The browser MCP remains an internal capability supplied to the selected runtime.
- **Cost semantics:** separate measured wall time, provider-reported token usage, modeled API cost and billed cost. Missing means unknown, never zero. Subscription runs can show tokens and a clearly labeled API-equivalent estimate without implying a per-run cash charge.
- **Capabilities over promises:** an unavailable billing endpoint, model catalog, structured output mode or MCP transport should produce a precise capability status. Preserve raw usage events for normalization changes and avoid double-counting cumulative totals.

## Remaining proof before enabling all three

1. Read-only version/capability probes on the installed binaries; a published doc is not local runtime evidence.
2. One controlled fixture per selected runner: model selection, browser MCP call, structured completion, cancellation and sanitized artifacts.
3. Verify token event shapes for successful, failed, cancelled and multi-turn runs; establish whether reported counts are cumulative or incremental.
4. Confirm Cursor local billing access for this account and correct mapping of returned local per-turn billing entries to a checker run.
5. Keep the selected personal-local auth mode explicit; revisit the separate deployment and credential requirements before adding other users or shared hosted workers.

No reviewed package removes these integration proofs. A thin runner boundary allows adopting ACP later without changing the checker’s MCP or persisted run model.
