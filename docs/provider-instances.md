# Native subscription instances

The checker runs the installed Claude Code CLI and Codex App Server using their native subscription logins. It does not need an Anthropic or OpenAI API key for text execution. Cursor authentication is shown separately from execution: Cursor remains gated until its native ACP tool/MCP isolation is verified.

In **Settings → Providers**, select an account to see its connection and models. **Add account** asks for a name, provider, and separate profile directory; a stable account ID is generated automatically. **Configuration → Advanced settings** exposes the executable and optional ID override. Existing account IDs cannot change.

Use **Sign in** or **Reconnect** to get the exact terminal command. Copy it, complete login in the native application, then choose **Check connection**. The command is expandable so its environment flags do not crowd the instructions. **Use account** opens that account's models in the composer. Model effort choices come from its native catalog. **Available models**, **Usage limits** (when reported), **Configuration**, and **Connection details** expand separately. Installation/version, native sign-in type, organization metadata, check time, and excluded API overrides remain available in Connection details. Workspace setup checks live under **Environments**.

Names, IDs, enable/disable state, paths, and supported default effort options are persisted in `.state/providers.json` (override with `E2E_PROVIDERS_PATH`). No credential values are stored there.

An instance is a configured account boundary; a provider kind identifies the harness. Instance IDs are stable. Editing requires the previous revision. Removing an instance removes only its checker configuration. Disabling does not sign out the native application. Active runs must finish or be cancelled before configuration changes; queued runs retain their original revision and fail if it changes. Native login remains an explicit terminal action, never a health-check side effect.

## Native profiles

- Claude: leave the directory empty for the existing default login. For another account, choose a fresh `CLAUDE_CONFIG_DIR` such as `~/.claude-personal`, then use the generated native login command. Preserve `HOME` and the system keychain. Even explicitly setting `CLAUDE_CONFIG_DIR=~/.claude` can select different native credential storage from leaving it unset; the checker preserves that distinction.
- Codex: choose a separate `CODEX_HOME` such as `~/.codex-personal`, then sign in with the generated `codex login` command. Codex owns its file/keyring credentials. The directory must exist (the guidance includes `mkdir -p`). Separate profiles keep auth, models, sessions, and configuration separate.
- Cursor: native default account inspection is available. Custom configuration directories and execution are not advertised as supported.

Profile aliases pointing to another configured account directory are rejected, including filesystem symlinks. No credential homes are copied, no credential files are read by the checker, and no existing default login is overwritten. A binary field accepts a command name or absolute path, not shell arguments. Typed effort options are supported; arbitrary launch arguments, environment secrets, endpoint overrides, and tool permission overrides are deliberately excluded from this QA harness.

The checker uses ephemeral Codex threads and does not continue conversations across accounts. T3's managed shadow-home arrangement for shared Codex sessions is therefore unnecessary here and is not implemented. A completely separate `CODEX_HOME` follows T3's documented fully separate profile mode.

## Subscription versus API billing

A concrete mismatch was reproduced on 2026-11-01: in this task's shell, `claude auth status --json` returned `authMethod: "api_key"` and `apiKeySource: "ANTHROPIC_API_KEY"`. Running the same probe with the override excluded returned `authMethod: "claude.ai"` and the native team subscription. The separately connected checker had reported subscription readiness; these processes had different environments. This establishes an ambient-key conflict in the task environment, not the provenance of the earlier user-visible prompt. The earlier speech-generation API connection was a separate capability; no speech connection is required for these text runs.

Subscription child processes exclude ambient API keys, endpoint/cloud-provider overrides and externally supplied auth tokens. Settings reports variable **names only**. Global environment variables and secrets are unchanged. Native profiles still reporting API billing are rejected with `AUTH_MODE_MISMATCH`; missing login, expired/rejected login, missing executable, unknown account identity, exhausted usage, and unsupported capabilities have separate actionable errors. There is no billed API worker fallback.

Provider token counts, API-equivalent estimates, provider-reported cost, and real billed cost remain separate. `billedCostUsd: null` means unknown. Neither a CLI dollar figure nor an API-equivalent estimate establishes a subscription charge. Session summaries use deterministic formatting without a model call. Optional narration text uses the chosen provider's fixed default instance and native subscription profile, independently of the verification account, with low effort when advertised. Speech uses a separate explicit API credential reference. See [Voice narration settings](session-demos.md#voice-narration-settings) for the shared UI/MCP controls and accounting boundaries.

## Selection and persistence

New targets accept `instanceId`, `options.effort`, and optional expected `instanceRevision`/`accountFingerprint`. Submission re-probes that exact instance and validates model/options before queuing the whole batch. Jobs persist the resolved target, revision, account fingerprint, resolved model, and an account/version/name and native configuration snapshot. Every native stage checks the identity again. Catalog refresh never silently substitutes an account or model. Codex additionally rejects a substituted model before starting a turn; Claude receives the catalog's resolved model ID when exposed.

The UI keeps an unavailable selection visible instead of moving it to a ready account. Explicit **Use account** changes the draft. Model selections for two instances remain separate even if their model IDs match. Historical job labels use the persisted instance name.

Legacy `{provider, model, authMode}` targets resolve to the fixed IDs `claude-code-default`, `codex-default`, or `cursor-default`, independent of the preferred UI account. These defaults cannot be deleted (they may be disabled). Existing history is readable without inventing historical account metadata. Restarted queued/running jobs become `interrupted` rather than being replayed under a potentially different login. Idempotency retries return the previously submitted jobs even after configuration changes.

Account identity uses only metadata returned by the native provider, never tokens. An external sign-in changing that identity invalidates pinned work on the next preflight. The checker cannot lock another terminal's native account mutations or revoke an already running provider process outside its lifecycle; use a dedicated profile and cancel its active runs before changing its native login.

## Shared HTTP and MCP operations

The UI and MCP use the same HTTP services and Zod schemas:

| HTTP | MCP | Operation |
| --- | --- | --- |
| `GET /api/providers?fresh=1&instanceId=personal` | `list_providers({fresh:true, instanceId:"personal"})` | Instance status, native account metadata, capabilities, timestamp, optional reported limits |
| `GET /api/providers?instanceId=personal` | `list_models({provider:"claude-code",instanceId:"personal",fresh:true})` | Instance model/effort catalog; omitted instance means fixed provider default |
| `POST /api/provider-instances` | `save_provider_instance` | `{instance:{id,provider,name,binaryPath,configDir?,enabled?,options?}, expectedRevision?}` |
| `POST /api/provider-instances/select` | `select_provider_instance` | `{instanceId,expectedRevision}`; preferred account for new UI drafts |
| `POST /api/provider-instances/auth` | `provider_login` | Exact native login/reconnect guidance; no credential exchange |
| `POST /api/provider-instances/delete` | `delete_provider_instance` | Remove a custom checker instance; preserve native credentials |

```json
{
  "provider": "claude-code",
  "instanceId": "claude-personal",
  "model": "sonnet",
  "authMode": "subscription",
  "options": { "effort": "high" }
}
```

Inspect `list_models` before choosing the model and effort. Limits/reset timestamps are shown only when native events/endpoints expose them. Codex uses `account/rateLimits/read`; Claude normalizes rejected `rate_limit_event` events during execution. No quota is guessed from plan names. Native status/model reads cannot prove a subsequent remote request will succeed; a revoked login or newly exhausted limit can still fail at execution time.

Status caches are scoped by instance/revision with a 30-second TTL. Fresh inspection replaces even an empty catalog; failures clear it. Submission preflight bypasses caches and pins the account even when a compatible saved spec may later be reused. Saved-spec execution makes no model call; explicit replay does not require a provider. Per-instance generation checks prevent older concurrent probes from overwriting newer results. Processes and cancellation scopes are owned by each run, never a provider-kind singleton. Health checks use version/auth and control/catalog operations, with no user prompt, login, installation, sign-out, native hooks, or inherited MCP launch.

## Reference and implementation differences

Inspected T3 Code at **`80120b1aa34a3125c05da393c8616c2076f5888d`**, rather than relying on a moving main branch. The implementation is independently authored; no T3 source was copied.

- [Provider constraints](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/docs/internals/providers.md) and [architecture](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/docs/internals/overview.md): driver/instance separation, adapter-owned protocols, passive health and accurate capabilities.
- [Adapter boundary](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/packages/provider-core/src/server/ProviderAdapter.ts), [instance registry](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/provider/ProviderInstanceRegistry.ts), [auth lifecycle](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/provider/ProviderAuthService.ts), and [status cache](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/provider/providerStatusCache.ts).
- [Configuration schemas](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/packages/contracts/src/settings.ts), [Settings form](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/web/src/components/settings/ProviderSettingsForm.tsx), and [Settings panel](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/web/src/components/settings/ProviderSettingsPanel.tsx).
- [Account list/editor](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/web/src/components/settings/ProviderInstanceCard.tsx), [add-account flow](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/web/src/components/settings/AddProviderInstanceDialog.tsx), and [authentication section](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/web/src/components/settings/ProviderAuthenticationSection.tsx): compact account navigation, focused settings rows, contextual sign-in actions, and folded configuration details. The checker uses explicit saves and terminal sign-in guidance rather than T3's embedded auth wizard.
- [Claude profile guide](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/docs/user/providers-claude.md), [home environment](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/provider/Drivers/ClaudeHome.ts), [driver](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/provider/Drivers/ClaudeDriver.ts), and [adapter](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts).
- [Codex profile guide](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/docs/user/providers-codex.md), [home/shadow layout](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/provider/Drivers/CodexHomeLayout.ts), [driver](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/provider/Drivers/CodexDriver.ts), and [adapter](https://github.com/pingdotgg/t3code/blob/80120b1aa34a3125c05da393c8616c2076f5888d/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts).

The checker keeps T3's native account boundaries, instance routing and explicit capabilities. It uses the native Claude CLI directly (including a control-only `initialize` for models) rather than adding T3's Agent SDK wrapper or manifest service. Codex remains App Server. It does not reproduce T3's commercial/remote managed ChatGPT auth, token broker, shared-session shadow homes, installers, arbitrary flags, or additional provider drivers. No T3 client identity or service credential is reused. Login guidance is intentionally native terminal guidance rather than an embedded credential flow.

Official references rechecked: [Claude authentication and precedence](https://code.claude.com/docs/en/authentication), [Codex authentication/storage](https://learn.chatgpt.com/docs/auth), and [App Server accounts, models, limits and lifecycle](https://learn.chatgpt.com/docs/app-server).

## Verification

`npm test` exercises fake native subprocesses with separate profiles for two Claude and two Codex accounts, plus the actual Settings/composer, HTTP service, and stdio MCP client with disposable configuration. Tests cover login metadata isolation, credential exclusion/redaction, exact selection and options, stale revisions/accounts, catalog replacement, rejected API billing, usage reset times, cancellation/process cleanup, inherited-tool denial, default migration, idempotency and persisted job identity. Browser/API tests do not make model calls or perform real sign-in.

Settings browser coverage also creates and removes a temporary account through the UI, checks generated IDs, edits account names, expands sign-in guidance, refreshes status, switches sections by keyboard, and checks for horizontal overflow at desktop, tablet, and mobile widths. Set `E2E_SETTINGS_SCREENSHOTS=/tmp/checker-settings-ui` when running `node --test tests/provider-api.test.ts` to save fixture screenshots for visual review.

Live fixture proof on 2026-11-01 used existing native logins without changing any account:

- Claude Code **2.1.316**, `sonnet`: exploration **pass**, codification **passed**, replay **passed**. Native initialization reported `apiKeySource: "none"`; exploration exposed only `mcp__stage__browser_*`/network tools and codification only the four stage tools. Evidence: `runs/20261101T153625-SMOKE-999999-slot999-good-2tz/smoke-summary.json`.
- Codex **0.166.0**, `gpt-6.1-sol`: exploration **pass**, codification **passed**, replay **passed**. Evidence: `runs/20261101T153804-SMOKE-999999-slot999-good-yyf/smoke-summary.json`.

These live runs consumed subscription allowance. Separate real accounts and interactive sign-in were not tested; multi-account isolation and failure cases use fake native profiles. Cursor native status was authenticated, execution remained disabled. The external prerequisite for a new account is its native installation/login; Cursor additionally needs verified tool isolation before execution can be enabled.
