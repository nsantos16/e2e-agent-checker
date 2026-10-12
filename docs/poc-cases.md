# PoC case selection (Qase DEMO)

Status: proposal · 2026-10-12 · Fixtures: `fixtures/qase/DEMO-<id>.json` (read-only snapshot pulled via the Qase MCP)

## Where these come from

- Qase projects: **DEMO** (6,171 cases, 633 suites), **DA** (Sample Automation, 375 cases), and **DCC** (Corporate Close, 50).
- DEMO already has an **`AI Testability`** custom field (full 307, partial 95, none 42, automated 0) and an **`Automation Ref`** field (`DA-<id> | tests/e2e/critical/<spec>.e2e.test.ts`). The team has already triaged which cases an agent should be able to test, and there's an existing e2e suite to compare against.
- Pool: the 253 unique cases rated `full`. Excluded for round one: Public API, Ask Sample answers (non-deterministic LLM output), and anything touching bank feeds, QBO/Xero, uploads, email, sync, or payments. That leaves 108 candidates, from which these were picked.

## Selection

| Bucket | Case | Steps | Why it's in | Precondition / data needed |
|---|---|---|---|---|
| A. Read-only, exact assertion | [DEMO-3949](https://app.qase.io/case/DEMO-3949) Comment search, no-results state | 4 | Simplest baseline, exact strings to assert | any practice with comments |
| A′. Vague legacy case | [DEMO-2359](https://app.qase.io/case/DEMO-2359) Add new comment | 3 | Old-style wording ("Able to see the comment added"), with preconditions given only as links to other cases. Tests how the agent handles a vague spec | any client |
| B. Persistence, rich text (control) | [DEMO-6004](https://app.qase.io/case/DEMO-6004) Single-line list items round-trip in client note | 3 | Rich-text editor typing plus auto-save. Guards the WMD-1920 fix from the other side, so it should PASS both before and after the fix | client with Notes access |
| C. Multi-step mutation with cleanup | [DEMO-6912](https://app.qase.io/case/DEMO-6912) Archive and unarchive a client | 6 | Crosses several pages, asserts "without refresh", and undoes its own change | firm admin, a **disposable** client, setting off |
| C′. Data-dependent filters | [DEMO-6915](https://app.qase.io/case/DEMO-6915) Task Name filter: unnamed + named + apostrophe | 6 | The agent must find its own test data and reason about filter results. Backend regression pair: fix `42a3e624c4`, pre-fix `de27537847`. Needs `local-workspace` (It-4) | tasks: one unnamed, two named, one with `'` |
| E/F. Regression pair | [DEMO-6003](https://app.qase.io/case/DEMO-6003) Shift+Enter list item persists after save | 5 | WMD-1920. Run it on frontend commit `04515988f4`, the commit before the fix, where it should **FAIL**, and on master, where it should **PASS**. Frontend-only, so no local backend is needed | client with Notes access |
| C″. Filters | [DEMO-6914](https://app.qase.io/case/DEMO-6914) Status filter retains tasks after Select all minus two | 4 | Filter reasoning. No fix commit was found, so it's not a regression pair | tasks in ≥ 3 statuses |
| D. Permissions, second role | [DEMO-6049](https://app.qase.io/case/DEMO-6049) Limited-access user sees only assigned clients' threads | 4 | Needs a second test user (exercises multiple 1Password roles) and a negative assertion | limited-access user, threads on an in-scope and an out-of-scope client |
| D′. Internal admin gate + redirects | [DEMO-6611](https://app.qase.io/case/DEMO-6611) Allowlisted admin sees Internal tab | 6 | Route and redirect assertions. Needs an allowlisted `@example.app`/`@example.com` user | allowlisted staff user |
| Stretch | [DEMO-6614](https://app.qase.io/case/DEMO-6614) Ledger Inspector filters persist in URL | 6 | Long, URL-heavy, includes debounce and malformed input. A hard ceiling test | allowlisted admin + ledger data |

Recommended order: 3949 → 2359 → 6003 (F on `04515988f4`, then E on master) + 6004 as control → 6912 → 6914 → 6915 → 6049 → 6611 → 6614.

Environment and test-data details: [target-app.md](target-app.md).

## Observations that affect the design

1. **Case quality varies a lot.** Recent cases (6xxx) have explicit preconditions and precise expected results, which suits an agent. Older ones (2xxx–3xxx) say things like "Able to edit a text", and their preconditions are links to other cases. The agent needs a rule for vague expectations: either derive a concrete assertion and **flag it as inferred** in the report, or mark the case as "spec too vague".
2. **Preconditions are the real dependency.** Most cases need specific data: a disposable client, tasks in three statuses, a limited-access user, an allowlisted admin. The local seed has to provide these, or the PoC needs a fixture-setup step per case. This is the main input needed from the app side.
3. **Regression pairs give us a "known broken" case for free.** 6003 (frontend, WMD-1920) and 6915 (backend) each guard a fix we found in git. Running them on the commit before the fix is a natural FAIL test.
4. **The DA project and `Automation Ref`** point at an existing `tests/e2e/critical/*.e2e.test.ts` suite. Its conventions (fixtures, login helpers, selectors) should shape what the codify step generates.
