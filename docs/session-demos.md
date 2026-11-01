# Session PR summaries and voice demos

A session has an ID and an explicit list of run IDs. One submission's case × model batch automatically becomes a session using its recorded `batchId`; saved-spec replays inherit their source session. Historical runs with a batch ID use that batch. Other historical runs are singletons, except replays whose source is still known. Membership never comes from timestamps, matching case names or worktree paths.

Choose **Generate summary** in a run's **Session PR summary** panel to read, copy or download the standard Markdown. **Combine runs into an explicit session** selects the exact existing runs for a cross-batch summary. MCP can create an empty session and pass its `sessionId` to successive `verify_case` / `verify_cases` calls. `add_session_runs` adds existing IDs with a membership revision check. Explicit collections may include a run that also belongs to its original batch; adding it does not move it or erase earlier membership. Hiding a run or archiving a case does not remove recorded session membership. Deleted or missing run records are listed as unavailable; cache expiry retains the saved run outcome and identifies missing artifacts.

The standardized format includes all members, case revisions/titles where saved, pipeline outcome, exploration results, deterministic replay results, environment and test user, recorded build ID/commit/dirty state, failure and blocked/incomplete work, step evidence, demos, and limitations. `done` is not a pass. Historical or hosted build commits remain unknown unless recorded; current checkout state is never used to invent a historical build. Per-run step evidence is capped at 100 entries, with a note when remaining steps are omitted; each evidence text is clipped to 600 characters. Session summaries use deterministic formatting: they require no text or speech model, and reads do not create demos or publish anything.

Session membership and summary snapshots persist under `.state/`. `E2E_STATE_DIR` can isolate this data (by default it follows the directory of `E2E_JOBS_PATH`, if configured). Summary revisions hash the actual evidence and membership, so unchanged reads return the same revision.

## MCP and HTTP

The UI and MCP use the same backend services and validation schemas.

| MCP | HTTP | Purpose |
| --- | --- | --- |
| `create_session({title,jobIds?})` | `POST /api/sessions` | Create an explicit session, optionally empty |
| `list_sessions()` | `GET /api/sessions` | Discover exact membership and revisions |
| — | `GET /api/sessions/:id` | Retrieve one membership record |
| `add_session_runs({sessionId,expectedRevision,jobIds})` | `POST /api/sessions/:id/runs` | Add known IDs without guessing |
| `get_session_summary({sessionId})` | `GET /api/sessions/:id/summary` | Generate/retrieve the standard evidence summary |
| — | `POST /api/sessions/:id/summary` | Same deterministic generation, no publication |
| — | `GET /api/sessions/:id/summary?format=markdown` | Download Markdown |
| `get_voice_settings()` | `GET /api/settings/voice` | Read defaults and reference readiness |
| `save_voice_settings(...)` | `POST /api/settings/voice` | Persist revision-checked defaults |
| `generate_demo({jobId,voice?,retry?})` | `POST /api/jobs/:id/demos` | Explicit asynchronous generation or cached retrieval |
| `get_demos({jobId})` | `GET /api/jobs/:id/demos` | Progress, options, usage, playable/downloadable artifact links |
| `cancel_demo({jobId,demoId})` | `POST /api/jobs/:id/demos/:demoId/cancel` | Cancel narration, preserving verification |
| `attach_to_pr({sessionId OR jobId,pr,publish:true,video?})` | `POST /api/publish` | Explicit publication using the same summary format |

Read `sessionId` on a run or `list_sessions` after submission. Example:

```json
{"title":"Search regression proof","jobIds":["job-a","job-b"]}
```

Pass the returned session ID to `get_session_summary`. The result includes Markdown, structured run evidence, counts, limitations and a content revision. URLs returned by summary/evidence retrieval are local to the checker, not public hosting links.

## Voice narration settings

**Settings → Voice narration** persists an enable/disable default, script model, speech model, voice, and a server-side credential reference in `.state/voice-settings.json` (subject to `E2E_STATE_DIR`). The run's **Demo narration** controls use that default or override enabled/model/voice for one requested demo. **Generate demo** is the explicit action that can spend speech API usage. Merely enabling the setting, installing the feature, viewing a run/summary, replaying a spec, or finishing a verification never starts narration.

Default: **off**, Codex `gpt-6-luna` for text, OpenAI `gpt-realtime-2.1-mini` for speech, `marin` voice. Claude Code `haiku` is an explicitly selectable subscription alternative. There is no silent provider/model substitution. Script selection runs separately from the verification model, with no tools and low effort when the native model advertises it. The Haiku alias is not assumed to resolve to a particular version or price.

Read settings before writing:

```json
{
  "expectedRevision":"REVISION_FROM_GET_VOICE_SETTINGS",
  "options":{
    "enabled":true,
    "textModel":"gpt-6-luna",
    "speechModel":"gpt-realtime-2.1-mini",
    "voice":"marin"
  },
  "speechCredentialRef":"env://E2E_SPEECH_API_KEY"
}
```

The reference may be `env://VARIABLE_NAME` or `op://vault/item/field`, matching the existing credential conventions. Configure the value in the server environment or 1Password. Never send a raw key through HTTP, MCP, the UI or a report. Keys are resolved only inside the speech service and scrubbed from native text-worker subprocess environments. The dedicated speech credential does not change native Codex/Claude subscription authentication. `configured` means a reference is present (and an environment reference exists); it does not prove live API access. 1Password resolution happens only during explicitly requested narration.

The text worker uses the chosen provider's default native instance, including its configured binary and profile. It requests low effort when the model advertises it, independently of verification options, and snapshots the resolved model, instance revision and account fingerprint in the demo's text usage. Changing the verification account does not silently change the narration provider.

Request voice or force silent output independently of the setting:

```json
{"jobId":"job-a","voice":{"enabled":true,"voice":"cedar"}}
```

```json
{"jobId":"job-a","voice":{"enabled":false}}
```

Off performs no text-model, speech, or credential-resolution calls. Effective options are snapshotted in the artifact, so later settings edits do not rewrite existing demos. Verification outcomes and verification usage are never updated by narration.

## Open-source speech options

Research checked 2026-11-01. These are candidates for a future explicitly selected local speech provider; they are not integrated with UI/MCP generation in this version. All three were subsequently exercised in an isolated [local voice comparison](research/local-voice-samples.md), with playable samples and measured CPU timings. Local synthesis avoids per-request speech API billing, but still uses local compute and requires an initial model download. Script generation can continue using the selected Codex/Claude subscription.

**Kokoro is a straightforward integration candidate for these short demos.** Its [82M model weights](https://huggingface.co/hexgrad/Kokoro-82M) and [inference library](https://github.com/hexgrad/kokoro) use Apache-2.0. The upstream [JavaScript implementation](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md) supports Node CPU inference, quantization and WAV output with preset voices such as `af_heart`. That is a direct fit for the checker's server and existing FFmpeg packaging. The Python implementation also documents Apple Silicon acceleration. Piper was faster in the local sample; the recordings are available for subjective voice-quality assessment.

[Piper](https://github.com/OHF-Voice/piper1-gpl) is another local engine with command-line, Python and HTTP interfaces. Its current engine is GPL-3.0; each [voice model's license](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/VOICES.md) must be checked separately. [Chatterbox Nano](https://huggingface.co/ResembleAI/chatterbox-nano) is an MIT-licensed 110M English model targeting CPU inference. Although its documented example uses a reference audio clip, its official checkpoint includes a built-in voice; the local comparison uses that voice without cloning anyone's supplied audio. It required current upstream Chatterbox and Perth source packages on this Mac.

## Evidence, synchronization and artifacts

New replays using `qaseStep` record actual step titles, timing and pass/fail/incomplete status in `replay-*/timeline.json`. The text worker selects among bounded, extractive script variants derived from those recorded labels/results. It cannot write a new verdict or invent a successful step. The opening narration states the pipeline and replay outcomes; unfinished work is incomplete. Speech transcript text must match the selected script after punctuation/case and small-number normalization. A mismatch is an error and the audio is not offered as a ready demo.

Qualified stabilization recordings retain their original step timing when reused as final replay evidence. Summaries distinguish historical exploration from current verification and show recorded build IDs when available. Archiving a run preserves session membership; deletion leaves an unavailable member, and cache expiry preserves saved outcomes with an explicit missing-artifact limitation. Active demo generation protects its source run from cache cleanup.

The speech transport uses the documented Realtime WebSocket workflow: session configuration, text conversation item, audio response, PCM chunks, transcript, and measured response usage. It does **not** call `/v1/audio/speech` with a Realtime model.

FFmpeg reuses the original replay. Step timing is aligned using observed wall-clock events, page closure and video duration, with approximate capture precision of 250 ms. A step's final frame can pause so its narration finishes before the next step. This is an explanatory cut, not a new browser execution. Original silent MP4 and burned-in step captions remain intact. The narrated artifact is H.264/AAC MP4 with faststart and a subtitle track; separate audio, WebVTT captions and the evidence script are downloadable. A spoken introduction, subtitle disclosure, MP4 title and UI label identify the voice as AI-generated.

Historical recordings or custom specs without step timing remain usable as silent evidence. Request a new saved-spec replay to capture timing; the checker never guesses historical step boundaries. Missing/overlapping timing, more than 12 steps, a recording longer than 10 minutes, or speech exceeding the 120-second budget produces an explicit narration error. Scripts are limited to 180 words and evidence input to 12,000 characters. At most two demos generate concurrently, with a four-minute overall timeout, a 45-second speech-segment timeout and cancellable subprocesses. No live path is implied by local fixture tests.

## Caching and separate usage

Demo IDs hash source video bytes, recorded timing/outcomes and effective options. Repeating the same request returns the same artifact and status. Script results are additionally cached by bounded evidence and text model/effort; PCM/transcripts are cached by spoken content, speech model and voice. A changed voice can reuse text; identical speech can be reused across runs. Reads never regenerate. `retry:true` resumes completed cached stages, including packaging failures.

An atomic request receipt is written before each model call. If a process is cancelled or crashes after the request begins but before a complete response is saved, usage may be incomplete. The same uncertain request is not sent again automatically, including after restart. This deliberately prevents an apparently harmless retry from rebilling an unknown request. The UI shows the error and retained artifacts; a completed global cache entry can still be reused. Never delete these receipts casually to retry a paid request.

Narration usage lives in the demo manifest, separately from verification `usage.json`. Text is native subscription usage with an **API-equivalent** estimate, not evidence of billing. Speech counts come from actual Realtime responses; a standard-rate dollar estimate is derived only when the required token categories are present. Missing usage stays unknown. `billedCostUsd` remains null, since response tokens do not establish the invoice. Cache-hit flags identify reused usage as provenance, not new consumption. See [usage and pricing](usage-pricing.md).

## Publication

Generation and publication are separate. Supply `publish:true` and a full destination PR URL only after the user requests that actual destination. Choose `video:"silent"` (default), `"narrated"` (latest ready narrated artifact for each recorded member), or `"none"`. Narrated publication requires a ready narrated artifact for each member with a replay video; it never generates one implicitly. GitHub allows up to 50 attachments, so larger sessions require a smaller explicit collection or publication without video.

The server uses the existing `gh pr comment --body-file --attach` path. It replaces local media links with attachment references, which `gh` rewrites to uploaded URLs. Session comments contain the standard result/evidence/failure/limitation sections. Concurrent publications for the same session/destination serialize. Exact content markers prevent duplicates after retries; changed evidence gets a new marker/comment. Existing per-job publication remains supported. Attachment URLs may be accessible to anyone with the URL.

## Verification and sources

Release checks at `afecea5` on 2026-11-01 passed: all 148 `npm test` tests, `npm run check`, `npm run build`, `node tests/demo-ui-smoke.ts`, `node tests/observability-smoke.ts`, and `node tests/stabilization-smoke.ts`.

The automated suite covers membership/outcomes, settings parity and persistence, off/on/errors/cancellation, content caches and interrupted-request receipts, native profile/identity isolation, transport events and measured usage, media encoding/audio energy, captions, active-demo retention protection, and mocked publication/deduplication. The demo UI smoke exercises the compiled UI and actual local API at 320, 390, 768 and 1280 pixels, then runs 12 playback and 82 workspace checks. Observation and stabilization smoke tests check real browser recording and retained step timing. All use local fixtures; no paid model/speech request or real PR publication is made. Live native narration text plus credentialed Realtime audio still require separate verification; the open-source sample generations above are a separate measured local path.

Official API details revalidated 2026-11-01:

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna): standard $0.10/M input, $0.01/M cached input and $0.50/M output; subscription estimates only.
- [GPT-Realtime-2.1 Mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini): $0.60/M input text, $0.06/M cached input text, $2.40/M output text, $20/M output audio.
- [Realtime WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime) and [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations): session/item/response events and PCM output workflow.
- [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech): synthetic-voice disclosure and the deprecation of older speech models; Realtime models require a different endpoint/workflow.
