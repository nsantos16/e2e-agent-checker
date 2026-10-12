---
status: accepted
date: 2026-10-12
---

# Test credentials come from a 1Password service account, resolved by the harness, never by the agent

Test-user credentials live in a dedicated `e2e-agent` vault in the `example.1password.com` account. They are read through a read-only 1Password service account whose token is kept in the macOS Keychain. The `op` CLI's desktop-app integration re-prompts after 10 minutes idle and every 12 hours, per terminal session, and the timeout can't be configured, so it can't support unattended runs in parallel across worktrees. Our harness resolves the secrets with `@1password/sdk` before handing anything to the agent. The agent's browser starts from a pre-authenticated `storageState`. Only cases that test login itself type a credential, and they do it through Playwright MCP `--secrets` placeholders. The LLM never holds a credential value, because once a secret is in the context it can be leaked through prompt injection and can't be revoked. Evidence: [credentials-1password.md](../research/credentials-1password.md).

## Considered Options

- **`op` CLI with the desktop-app integration**: rejected because of the constant authorization prompts described above.
- **1Password's official Environments MCP**: returns secret names, not values, by design, so it can't log a browser in.
- **Community 1Password MCP servers**: rejected because they put plaintext secrets into the model context.
- **Our own vault**: rejected. It would duplicate the secrets, rotations would drift, and we would own the security. The only local state we keep is short-lived session state (`storageState`), which is gitignored and per worktree.

## Interim: desktop-app auth until a service account exists

The account permissions to create a service account aren't available yet. Until an admin creates one, the harness uses `@1password/sdk` ≥ 0.4.0 with `DesktopAuth("<account_uuid from op account list>")`, behind the same `CredentialProvider` interface. It costs one approval when the daemon starts:

1. On startup, resolve every `op://e2e-agent/...` reference that the configured roles need, in a single batch.
2. Keep the values in daemon memory only. Never write them to disk or env files, and pass them to setup scripts and `--secrets` through process memory or pipes.
3. Re-prompt only when the daemon restarts, or when a `storageState` has expired and a role has to log in again. A role is logged in once per worktree and its session reused.

Switching to the service account later is a config change from `DesktopAuth` to the token, with no code change. Until then, the test users must live in a vault the requesting user can read.

## Consequences

- A service account's vault access can't be changed after it is created. Changing its scope means creating a new service account and replacing the token in the Keychain.
- Playwright traces record `fill()` values, so `trace.zip` must never leave the machine or be attached to a PR.
- Generated specs read credentials from `process.env`, never from literal values.
- Playwright MCP must be ≥ 0.0.77, the first version that redacts `--secrets` values from console logs.
