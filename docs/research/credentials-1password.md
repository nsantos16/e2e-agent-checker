# Test credentials from 1Password without constant prompts

Status: research + proposal · 2026-10-12

## Requirements

1. The tool runs unattended and in parallel across worktrees, so it can't depend on a human approving each read.
2. **The LLM never sees a credential.** It shouldn't appear in prompts, snapshots, tool results, generated specs or the PR video. Prompt injection from the app under test is a real risk, and once a secret enters the context there's no way to revoke it.
3. Access is scoped, revocable and auditable.

## Options

| Option | Prompts? | LLM sees secret? | Verdict |
|---|---|---|---|
| `op` CLI via **desktop app integration** | Yes. Authorization expires after 10 min idle, 12 h hard cap, per terminal session, and the timeout can't be configured | No (if used by the harness) | ❌ This is the source of the "constantly asking" problem |
| **Service account** (`OP_SERVICE_ACCOUNT_TOKEN`) with `op` CLI or the `@1password/sdk` JS SDK | **No** | No (if used by the harness) | ✅ **Recommended** |
| Official **1Password Environments MCP** (Codex/Cursor) | — | No: by design it returns **names, not values** | ❌ for login. It can't put a password into our browser. 1Password says it won't expose raw secrets over MCP |
| Community 1Password MCP servers | — | **Yes**, the secret enters the model context | ❌ Violates requirement 2 |
| 1Password Environments **local `.env` mount** (named pipe, beta, macOS/Linux) | Approval on read, then open until 1Password locks | No | 🤔 Good for the *app's* dev secrets (DB URL, API keys). The approval behaviour is too unclear for an unattended daemon |
| **Build our own vault** | No | No | ❌ Duplicates secrets, rotation drifts, and we'd own the security. Only short-lived session caches are acceptable (see below) |

## Proposed design

```
one-time (human):  create vault "e2e-agent" with test users per role/env
                   create service account → read-only on that vault only
                   store token in macOS Keychain (security add-generic-password)

daemon start:      read token from Keychain → @1password/sdk createClient()

per job:           CredentialProvider.resolve("op://e2e-agent/<role>/password")  (in harness, never in agent)
                   ├─ auth setup: deterministic Playwright login → storageState/<worktree>/<role>.json
                   │             → agent's browser starts already logged in   (default path)
                   └─ login-flow cases only: write a temp dotenv (0600) for Playwright MCP --secrets
                                 agent types placeholder E2E_PASSWORD → server substitutes the value
                   delete temp files at job end
```

- **Main path: `storageState`.** Most Qase cases assume a logged-in user. A Playwright setup script logs in deterministically, without the agent, and saves cookies/localStorage for each worktree and role. The agent and the replayed spec both start from that state. This is also faster and saves the agent several turns.
- **Login-flow cases: Playwright MCP `--secrets`.** The agent sees only the key name, and the server substitutes the real value. Requires `@playwright/mcp ≥ 0.0.77`, which fixed a leak of secret values through console logs.
- **Generated specs** read `process.env.E2E_<ROLE>_PASSWORD`, which the replay runner fills in from the SDK. Specs never contain literal values.
- **MFA:** if test users have TOTP, keep the seed (or `otpauth://` URL) in a one-time password field of the same item and resolve `op://e2e-agent/<role>/one-time password?attribute=otp` in the harness. This is documented for both `op read` and the SDK's `secrets.resolve`. ✅ Verified in the docs.

## Interim without service-account permissions

The JS SDK (≥ 0.4.0) supports `DesktopAuth(account)`, which uses the same approval prompt from the 1Password app as the CLI. To keep it to one prompt per daemon start, resolve all the role secrets in one batch on startup, keep them in memory only, and reuse `storageState` sessions so a password is needed again only when a session expires. Source: https://github.com/1Password/onepassword-sdk-js/

## Leaks to guard against

- **Playwright traces record `fill()` values.** `trace.zip` can contain the password, so traces stay local and are never attached to PRs.
- **The PR video is public by URL** (GitHub user-attachments). Use test users and data with no real customer information, and make sure no screen shows secrets (API keys pages, etc.).
- **Rate limits** (✅ verified): 1,000 reads/hour per token on Individual, Families and Teams, with 5,000/day per account on Teams. On Business it's 10,000 reads/hour and 50,000/day. Some CLI commands make several requests, so use item and vault IDs and resolve once per job. At about 3 secrets per job, even the Teams limit allows hundreds of jobs per hour.
- **Availability** (✅ verified): every plan, up to 100 service accounts. You need "adequate account permissions" to create one, otherwise an admin has to grant access.
- **Immutable** (✅ verified): a service account's vault access and permissions can't be changed after creation. To change scope you create a new one, so decide the vault layout first.
- **Vault restriction** (✅ verified): a service account can't be granted the built-in Personal, Private or Employee vaults, or the default Shared vault. Test users must live in a dedicated vault.

## Sources

- Service accounts with CLI: https://www.1password.dev/service-accounts/use-with-1password-cli
- CLI app integration security model (10 min / 12 h): https://www.1password.dev/cli/app-integration-security
- Authorization timeout not configurable (community): https://www.1password.community/developers-69/authorization-timeout-when-using-cli-22467
- SDK load secrets (incl. `?attribute=otp`): https://developer.1password.com/docs/sdks/load-secrets
- Secret reference syntax (`otp` attribute): https://www.1password.dev/cli/secret-reference-syntax/
- Service accounts overview and get started (limits, immutability, vault restrictions): https://www.1password.dev/service-accounts/, https://www.1password.dev/service-accounts/get-started
- Service account rate limits: https://www.1password.dev/service-accounts/rate-limits
- 1Password on MCP ("access without exposure"): https://1password.com/blog/where-mcp-fits-and-where-it-doesnt
- Environments MCP (names, not values): https://1password.com/blog/the-1password-environments-mcp-server-is-now-on-cursor-marketplace, https://1password.com/press/2026/may/openai-codex-integration
- Local .env mount: https://www.1password.dev/environments/local-env-file
- Playwright MCP secrets and console redaction fix: https://www.mintlify.com/microsoft/playwright-mcp/guides/security, https://bug0.com/blog/playwright-mcp-cli-secret-redaction-2026
- 1Password-backed Playwright MCP wrapper (community): https://mcpservers.org/servers/jochenseeber/playwright-secure-mcp
