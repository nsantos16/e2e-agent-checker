---
status: accepted
date: 2026-10-12
---

# PoC worktrees run the frontend locally against the shared development backend, isolated by pool user

For iterations 1–3, each worktree runs only the frontend (`yarn staging --port <4000+slot> --strictPort`) against the shared development API (`usa-serv.example-api.com`, the environment people call "staging"). No local backend or database is involved. The backend already accepts any origin and authenticates with a header, so any localhost port works. This is the fastest route to answering the PoC's correctness, video and cost questions. Worktrees that change the backend use the existing `yarn local-workspace --mode dev` launcher from iteration 4 onwards. That launcher still shares the dev database, so **data is never isolated per worktree. The isolation unit is the test user**: `eugene@example.com` for single runs, and one pool user (`eugene+e2eworker02..05`) per parallel slot, which caps parallelism at 4. Evidence: [target-app.md](../target-app.md).

## Considered Options

- **Local backend + local DB per worktree:** rejected for now. The compose file binds fixed host ports, `local-workspace` refuses `local_db`, and there's no seed data beyond the dev-db snapshot.
- **Backend previews** (isolated Postgres per branch): kept for later, for cases that need a clean DB. They're capped at 5 stacks with a 7-day TTL, they're slow to start, and third-party OAuth doesn't work there.

## Consequences

- Agents may create, edit and archive data on the shared dev environment, but **only on entities they create themselves or on dedicated disposable fixtures**. Every mutating case must undo or clean up after itself. Hourly CI e2e and humans use the same data.
- `storageState` (which includes IndexedDB) is per origin, so each slot logs in once for its own `localhost:<port>`.
- Test users must not have MFA enrolled.
- Results depend on dev-environment LaunchDarkly flags for the test practice.
