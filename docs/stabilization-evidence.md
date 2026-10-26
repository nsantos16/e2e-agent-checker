# Reusing stabilization evidence

When verification authors a new spec, it normally packages the final qualified `try_spec` attempt from that run as its final result and recording. It does not execute the same spec again just to obtain evidence. Passing tests and verified product assertion failures qualify. The PR comment and API provenance explicitly identify the stabilization attempt and say that there was no second execution. [Automatic saved-spec reuse](saved-spec-reuse.md) always executes the spec again on the requested target; historical stabilization evidence never qualifies for promotion.

`confirmationReplay: true` on `verify_case` / `verify_cases` (or `--confirmation-replay` on the CLI) requests an independent final execution. Existing `replay_job` / `--replay-only` always execute the saved spec. Every additional `replaySlots` target also executes independently.

## Qualification

The stage tool allocates an attempt directory before starting Playwright. A version 1 manifest lives beside that directory as `codify/attempts/attempt.<id>.manifest.json`; Playwright may clear its output directory without destroying the manifest or adjacent execution log. `codify/last-attempt.json` contains the same manifest. Directory modification times are never used to select an attempt.

The manifest records execution state, exit code, start/end times, measured process wall time, result, spec hash and a hashed inventory of artifacts. Identity snapshots before and after execution include:

- Spec, statically resolved local helper imports, shared helper/observer/configuration, lockfile, Playwright packages/browser revision metadata and relevant environment inputs. Unresolved external or dynamic imports fall back to replay.
- Captured case project, ID, revision and content, plus the exploration report used to verify the outcome.
- Local target origin/slot, running server PID/start identity, worktree HEAD, tracked/untracked source contents and modification times, Vite mode/env files and dependency installation metadata.
- Environment ID/revision/configuration hash, user identity, and session file path/hash. Credentials and session contents are not copied into the manifest.

Known identities are retained even when another identity is unavailable. A hosted origin currently has no deployment/build identity adapter, so hosted targets replay. Missing revisions, unresolved build inputs and unmanaged targets also replay.

Promotion requires the last attempt from this run, matching identities before/after execution and again before/after packaging, a normally completed single test with no retries or runner errors, and intact result/log/network/video/trace artifacts. Evidence older than 30 minutes is rejected. A failure must be an assertion failure at the same numbered step verified by codification and exploration. Cancellation, timeouts, skipped tests, partial reports, changed inputs, missing/ambiguous recordings, malformed evidence (including trace ZIP/event streams) and conversion errors all prevent promotion. Cancellation of the current verification stops work instead of starting a fallback replay.

The MP4 is converted from the video attachment named in the attempt's Playwright result. Original video, trace, screenshots, error context, network diagnostics and logs remain in the attempt directory. Captions are enabled explicitly. Promoted videos retain stabilization's `slowMo: 0`; independent replay retains its default `slowMo: 250`. Multi-video attempts conservatively replay because the primary recording is ambiguous.

## Format compatibility

- Existing `summary.replays[]`, job `replay`/`video`, MP4 paths and trace URLs remain available. A `replays[]` entry can now represent promoted stabilization evidence; consumers must inspect `provenance.kind` instead of assuming a second run.
- New provenance distinguishes `stabilization` (`independentRun: false`, attempt/manifest/original-video paths) from `replay` (`independentRun: true`, optional fallback reason). `results` and `diagnostics` link back to original evidence.
- `executionMs` is zero when packaging a reused attempt; its original measured execution time lives in provenance. `avoidedExecutionMs` uses that measured source duration as an estimate of the omitted execution, not a measurement of an unperformed replay. `wallMs` measures actual final-evidence work, including qualification and conversion. These fields do not add the original execution to job timing a second time.
- Compact job/evidence responses expose provenance and avoided time. `get_evidence` adds paged `attempt` and `results` artifacts.
- Old manifests/reports remain readable through existing artifact access but cannot be promoted. Replay remains the fallback. The old `attempts`, `code`, `specHash` and `result` keys remain on `last-attempt.json`; new manifests also exist while an attempt is running or cancelled, so consumers must check `state`.
- Job stage timing may now include `evidence` for qualification. Promotion enters `package` without entering `replay`.

## Verification and measured time

`npm test` covers eligibility, changing spec/helper/environment/case/session/build inputs, stale/malformed/partial evidence, missing recordings, verified assertion failures, cancellation and replay fallback. `npm run check` checks backend and client types.

Run `node tests/stabilization-smoke.ts` for a local integration regression using real Playwright/ffmpeg and injected provider responses, with no subscription calls. A server request counter proves one execution for a pass and for a verified product failure, and two for confirmation/additional-target verification. It also checks actual replay fallback for missing recordings, malformed manifests, changed builds and changed specs. The script retains artifact directories and prints timings and video paths.

On 2026-10-26, the final macOS local fixture measurement was:

| Scenario | Executions | Avoided-time estimate from measured attempt | Final packaging/qualification | Measured independent replay |
| --- | ---: | ---: | ---: | ---: |
| Pass | 1 | 984 ms | 206 ms | — |
| Verified assertion failure | 1 | 1,129 ms | 107 ms | — |
| Confirmation requested | 2 | 0 ms | included in final 1,199 ms | 1,145 ms |
| Additional target | 2 | 938 ms on primary target | 101 ms on primary target | 1,111 ms on additional target |

The measured redundant execution is about 1.15 seconds for this deliberately small fixture. This is not a production-suite benchmark; larger specs and slow-motion replay can avoid substantially more execution time. A frame extracted from the promoted failure MP4 retained the step caption.
