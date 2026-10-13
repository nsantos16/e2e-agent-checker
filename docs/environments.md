# Environments and test users

Open **Settings → Environments** to create or edit profiles. Each profile has a stable ID, a display name, a target, and one or more test users. The existing `config/roles.json` becomes the initial **Local development** profile until settings are saved. Edits live in `.state/environments.json` (gitignored, local to this checkout); back up that file to move settings. Stored credentials are references, never resolved secret values.

Targets:

- **Local worktree:** choose a frontend worktree in the composer. The profile's development mode selects the frontend's Vite mode (`ci.development` by default). Existing frontend mode files determine API/backend configuration. Different environment/mode/worktree combinations get separate dev-server slots; editing users alone reuses the dev server.
- **Hosted URL:** supply an HTTP(S) origin, such as `https://staging.example.com`. No frontend checkout or local dev server is required. The harness logs into that deployment and uses the same URL and session for exploration, codification and replay.

Each user has a unique ID within its environment, a display name, and username/password references. An optional one-time-code reference supports the existing MFA flow. Examples:

```text
Username: env://QA_STAGING_USERNAME
Password: op://Engineering/QA staging/password
One-time code: op://Engineering/QA staging/one-time password?attribute=otp
```

Both username and password may use either reference type. `env://NAME` reads the variable from the **checker app process**, not a browser or model process. Set the variables before starting the app; restart it after changing its process environment. `op://...` uses the configured 1Password account and existing SDK/CLI authentication. For MFA, use a 1Password current-OTP reference; an environment variable must contain a current code, not a TOTP seed. Settings validates reference syntax but does not authenticate until a run starts. Plaintext password values are rejected.

Choose the environment in the composer and its test user in **Run options**. Switching environments replaces the available user list; the app remembers the user separately for each environment. Hosted targets hide the worktree control. Run history and MCP job summaries show the recorded environment and user. Changes made through MCP appear in the UI on its next environment refresh (approximately ten seconds while visible).

## Sessions and edits

New runs pin the environment configuration and selected user at submission. Editing Settings cannot silently redirect a queued run to another URL. Browser session files are keyed by environment ID, profile revision, user ID and origin, stored under `.state/sessions/` with owner-only permissions, and reused for up to six hours. Saving a profile creates a new revision and thus a new session path, including when rotating a secret behind an unchanged reference. Configured credential environment variables and the 1Password service-account token are stripped from model, replay and dev-server child processes. Resolved credentials stay in the login harness; MCP discovery/job responses contain no secret values. Login failures do not save screenshots or expose entered field values in error messages.

Runs using the same username reference are serialized, including aliases in different profiles. Runs using the same environment/user ID are also serialized. Different references that secretly resolve to the same backend account cannot be recognized as aliases; configure the same username reference for a shared identity. Distinct accounts still need application-level data isolation for safe parallel mutation.

The default local profile cannot be deleted. Other profiles cannot be deleted while they have queued/running/cancelling jobs. Historical evidence survives deletion. Replay preserves the original environment snapshot and checks that the profile and user still exist; Run again uses the currently configured profile and fails if the old environment or user was removed.

The current login adapter remains the Sample email/password/MFA flow, including its IndexedDB session handling. This adds environments for the same application; it does not automatically support arbitrary applications, SSO-only flows, or custom login selectors. Direct CLI slot commands retain their older slot/role interface; environment selection is available through the app and MCP.

## MCP

- `list_environments({})`: compact profiles, target URLs and test users, without credential references or secret values.
- `list_environments({detail:true})`: editable profile definitions with references, never resolved values.
- `save_environment({environment, expectedRevision?})`: create a new ID or replace an existing profile using its current revision. Updates replace the full user list. Concurrent stale writes return `REVISION_CONFLICT`.
- `delete_environment({environmentId,expectedRevision})`: delete an unused non-default profile.
- `get_setup({environmentId,userId})`: requirements scoped to that target and user.
- `verify_case` and `verify_cases`: accept `environmentId` and `userId`. The default remains `local`; `role` remains a compatible user-ID alias. `worktreePath` is required only for local worktree targets.

Hosted example:

```json
{
  "project": "LOCAL",
  "caseId": 1,
  "environmentId": "staging",
  "userId": "admin",
  "target": {"provider":"codex","model":"ACTUAL_DISCOVERED_MODEL"},
  "idempotencyKey": "staging-admin-case1-try1"
}
```

Reconnect the MCP client after updating to v0.6 to load all 25 tools. Environments do not add credentials to prompts, tool arguments or run logs; only reference configuration is accepted by `save_environment`.

## Verification

`npm test` covers profile validation, revision conflicts, reference-only storage, session keys, credential resolution, HTTP/MCP configuration, hosted submissions without worktrees, and queued configuration snapshots. Browser tests cover environment/user Settings, saving multiple users, target-dependent controls, per-environment selection, deletion and mobile layout. `node tests/environment-login-smoke.ts` exercises the real login harness against two disposable localhost applications and checks distinct cookie/IndexedDB states and file permissions. No real test-account login or paid model execution is required by these checks.
