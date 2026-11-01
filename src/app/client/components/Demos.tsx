import { SelectPicker } from './Picker.tsx';
import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { errorMessage } from '../api.ts';
import { dollars } from '../format.ts';
import { speechVoices, saveVoiceSettingsSchema, generateDemoSchema, type VoiceReadiness } from '../../../demo-contract.ts';
import type { demoView } from '../../../demos.ts';
import type { JobView } from '../types.ts';
import type { RunSession } from '../../../sessions.ts';
import type { SessionSummary } from '../../../session-summary.ts';

export function VoiceSettings() {
  const { actions: store } = useWorkspace();
  const [value, setValue] = useState<VoiceReadiness>();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    void store
      .api<VoiceReadiness>('/api/settings/voice')
      .then(setValue)
      .catch((e) => setMessage(errorMessage(e)));
  }, [store]);
  const settings = value?.settings;
  return (
    <div id="voice-settings" role="tabpanel" aria-labelledby="voice-tab" className="dialog-body voice-settings">
      <header className="narration-heading">
        <h3>Voice narration</h3>
        <p>Add a short explanation to recorded demos with an AI-generated voice. Original silent evidence stays available.</p>
      </header>
      {settings && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage('');
            try {
              const { revision, speechCredentialRef, ...options } = settings;
              const body = saveVoiceSettingsSchema.parse({
                expectedRevision: revision,
                options,
                speechCredentialRef,
              });
              setValue(await store.api<VoiceReadiness>('/api/settings/voice', body));
              setMessage('Voice narration settings saved.');
            } catch (e) {
              setMessage(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="voice-fields">
            <label className="voice-toggle">
              <input
                type="checkbox"
                aria-labelledby="voice-default-label"
                aria-describedby="voice-default-help"
                checked={settings.enabled}
                onChange={(e) =>
                  setValue({
                    ...value,
                    settings: { ...settings, enabled: e.target.checked },
                  })
                }
              />
              <span>
                <strong id="voice-default-label">Enable voice by default for requested demos</strong>
                <small id="voice-default-help">
                  Generation starts only when you choose Generate demo. You can override this for each demo.
                </small>
              </span>
            </label>
            <section className="voice-section" aria-labelledby="script-settings-heading">
              <div className="narration-heading">
                <h4 id="script-settings-heading">Narration script</h4>
                <p>Uses your selected native subscription, independently of the verification model.</p>
              </div>
              <label className="narration-field">
                Script model
                <SelectPicker
                  label="Narration script model"
                  value={settings.textModel}
                  onChange={(next) => setValue({ ...value, settings: { ...settings, textModel: next as typeof settings.textModel } })}
                  options={[
                    { value: 'gpt-6-luna', label: 'Codex · gpt-6-luna · low effort' },
                    { value: 'haiku', label: 'Claude Code · haiku' },
                  ]}
                />
              </label>
            </section>
            <section className="voice-section" aria-labelledby="speech-settings-heading">
              <div className="narration-heading">
                <h4 id="speech-settings-heading">Speech audio</h4>
                <p>Speech uses a separate paid API. A server credential is required to generate audio.</p>
              </div>
              <div className="voice-grid">
                <label className="narration-field">
                  Speech model
                  <input readOnly value={settings.speechModel} />
                </label>
                <label className="narration-field">
                  Voice
                  <SelectPicker
                    label="Narration voice"
                    value={settings.voice}
                    onChange={(next) => setValue({ ...value, settings: { ...settings, voice: next as typeof settings.voice } })}
                    options={speechVoices.map((voice) => ({ value: voice, label: voice }))}
                  />
                </label>
              </div>
              <label className="narration-field">
                Server-side speech credential reference
                <input
                  value={settings.speechCredentialRef ?? ''}
                  placeholder="env://E2E_SPEECH_API_KEY"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="speech-credential-help"
                  onChange={(e) =>
                    setValue({
                      ...value,
                      settings: {
                        ...settings,
                        speechCredentialRef: e.target.value || null,
                      },
                    })
                  }
                />
              </label>
              <p className="narration-help" id="speech-credential-help">
                Use an <code>env://</code> or <code>op://</code> reference. Store the secret in your server credential manager.
              </p>
              <div className="voice-connection">
                <span>Speech connection</span>
                <strong>
                  {value.speech.status === 'configured'
                    ? 'Reference available'
                    : value.speech.status === 'missing'
                      ? 'Credential missing'
                      : 'Not configured'}
                </strong>
                <small>Live access is unverified.</small>
              </div>
            </section>
            <p className="narration-help">
              Text estimates and speech usage are tracked separately from verification. Cost estimates are not bills.
            </p>
            <div className="narration-actions voice-actions">
              <button type="submit" className="primary narration-button">
                {busy ? 'Saving…' : 'Save voice settings'}
              </button>
              <button
                type="button"
                className="narration-button"
                onClick={() =>
                  void store
                    .api<VoiceReadiness>('/api/settings/voice')
                    .then(setValue)
                    .catch((e) => setMessage(errorMessage(e)))
                }
              >
                Reload settings
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {!settings && !message && <p className="narration-help">Loading voice settings…</p>}
      <p role="status" className="narration-message">
        {message}
      </p>
    </div>
  );
}

type Demo = ReturnType<typeof demoView>[number];
export function DemoPanel({ job, active }: { job: JobView; active: boolean }) {
  const { state, actions: store } = useWorkspace();
  const [settings, setSettings] = useState<VoiceReadiness>();
  const [demos, setDemos] = useState<Demo[]>([]),
    [override, setOverride] = useState('default');
  const [voice, setVoice] = useState(''),
    [model, setModel] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const players = useRef(new Map<string, HTMLVideoElement>());
  useEffect(() => {
    if (!active) for (const player of players.current.values()) player.pause();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const r = await store.api<{ demos: Demo[] }>(`/api/jobs/${job.id}/demos`, undefined, controller.signal);
        setDemos(r.demos);
      } catch (e) {
        if (!controller.signal.aborted) setMessage(errorMessage(e));
      } finally {
        loading = false;
      }
    };
    void store
      .api<VoiceReadiness>('/api/settings/voice', undefined, controller.signal)
      .then(setSettings)
      .catch((e) => {
        if (!controller.signal.aborted) setMessage(errorMessage(e));
      });
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [store, job.id, active, state.dialog]);
  const generate = async (retry = false) => {
    setBusy(true);
    setMessage('');
    try {
      const input = generateDemoSchema.parse({
        voice: {
          ...(override === 'default' ? {} : { enabled: override === 'on' }),
          ...(voice ? { voice } : {}),
          ...(model ? { textModel: model } : {}),
        },
        retry,
      });
      await store.api(`/api/jobs/${job.id}/demos`, input);
      setDemos((await store.api<{ demos: Demo[] }>(`/api/jobs/${job.id}/demos`)).demos);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="demo-panel" aria-label="Demo narration">
      <header className="narration-heading">
        <h3>Demo narration</h3>
        <p>Choose how to present this replay. Your original recording and test result are preserved.</p>
      </header>
      <div className="demo-controls">
        <label className="narration-field">
          Voice narration
          <SelectPicker
            label="Demo voice narration"
            value={override}
            onChange={setOverride}
            options={[
              { value: 'default', label: `Use setting (${settings?.settings.enabled ? 'on' : 'off'})` },
              { value: 'on', label: 'On for this demo' },
              { value: 'off', label: 'Off — silent replay' },
            ]}
          />
        </label>
        <label className="narration-field">
          Script model
          <SelectPicker
            label="Script model"
            value={model}
            onChange={setModel}
            options={[
              { value: '', label: `Use setting (${settings?.settings.textModel ?? 'loading'})` },
              { value: 'gpt-6-luna', label: 'Codex · gpt-6-luna' },
              { value: 'haiku', label: 'Claude Code · haiku' },
            ]}
          />
        </label>
        <label className="narration-field">
          Voice
          <SelectPicker
            label="Voice"
            value={voice}
            onChange={setVoice}
            options={[
              { value: '', label: `Use setting (${settings?.settings.voice ?? 'loading'})` },
              ...speechVoices.map((voice) => ({ value: voice, label: voice })),
            ]}
          />
        </label>
      </div>
      <div className="narration-actions demo-actions">
        <p className="narration-help">
          Voice on uses a separate paid speech API. Generation starts only when requested.
          {settings?.speech.status !== 'configured' && (
            <span className="speech-readiness">
              Speech credential: {settings?.speech.status === 'missing' ? 'missing' : settings ? 'not configured' : 'checking…'}
            </span>
          )}
        </p>
        <button className="primary narration-button" disabled={busy || !settings} onClick={() => void generate()}>
          Generate demo
        </button>
      </div>
      {demos.map((d) => (
        <div className="demo-artifact" key={d.id}>
          <p role="status" className="demo-progress">
            <strong>
              {d.synthetic ? 'AI-generated voice narration' : 'Silent replay'} · {d.status}
            </strong>
            <span>{d.progress}</span>
          </p>
          <p className="meta">
            {d.options.textModel} · {d.options.speechModel} · {d.options.voice}
          </p>
          {['queued', 'scripting', 'speaking', 'packaging'].includes(d.status) && (
            <button
              className="narration-button"
              onClick={() => void store.api(`/api/jobs/${job.id}/demos/${d.id}/cancel`, {}).catch(store.report)}
            >
              Cancel narration
            </button>
          )}
          {['error', 'cancelled', 'interrupted'].includes(d.status) && (
            <button
              className="narration-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await store.api(`/api/jobs/${job.id}/demos`, {
                    voice: d.options,
                    retry: true,
                  });
                } catch (e) {
                  setMessage(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Retry using cached stages
            </button>
          )}
          {d.artifacts.video && (
            <>
              <video
                ref={(element) => {
                  if (element) players.current.set(d.id, element);
                  else players.current.delete(d.id);
                }}
                src={d.artifacts.video}
                controls
                preload="metadata"
              >
                <track kind="captions" label="Narration" src={d.artifacts.captions} srcLang="en" />
              </video>
              <div className="narration-links">
                <a href={d.artifacts.video + '?download=1'}>Download narrated MP4</a>
                <a href={d.artifacts.script}>Evidence script</a>
                <a href={d.artifacts.audio + '?download=1'}>Download audio</a>
              </div>
            </>
          )}
          {d.status === 'silent' && <a href={`/api/jobs/${job.id}/artifacts/video`}>Play silent replay</a>}
          {d.textUsage && (
            <p className="meta">
              Narration text: {dollars(d.textUsage.usage.estimatedApiCostUsd)} API-equivalent estimate · subscription billed amount unknown
            </p>
          )}
          {(d.textCacheHit || d.speechCacheHits?.some(Boolean)) && (
            <p className="meta">
              Cached text: {d.textCacheHit ? 'yes' : 'no'} · cached speech segments: {d.speechCacheHits?.filter(Boolean).length ?? 0}.
              Reused usage is provenance, not a new charge.
            </p>
          )}
          {!!d.speechUsage.length && (
            <p className="meta">
              Speech API:{' '}
              {d.speechUsage.every((u) => u.outputAudioTokens !== null)
                ? d.speechUsage.reduce((n, u) => n + u.outputAudioTokens!, 0)
                : 'Unavailable'}{' '}
              recorded audio output tokens ·{' '}
              {dollars(
                d.speechUsage.every((u) => u.estimatedApiCostUsd !== null)
                  ? d.speechUsage.reduce((n, u) => n + u.estimatedApiCostUsd!, 0)
                  : null,
              )}{' '}
              standard-rate estimate · billed amount unknown
            </p>
          )}
          {d.usageMayBeIncomplete && <p>Partial request usage is unavailable; no automatic rebilling.</p>}
        </div>
      ))}
      <p role="alert" className="narration-message">
        {message}
      </p>
    </section>
  );
}

export function SessionPanel({ job }: { job: JobView }) {
  const { state, actions: store } = useWorkspace();
  const [summary, setSummary] = useState<SessionSummary>(),
    [sessions, setSessions] = useState<RunSession[]>([]);
  const [sessionId, setSessionId] = useState(job.sessionId ?? job.batchId ?? job.id);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [pr, setPr] = useState(''),
    [video, setVideo] = useState('silent');
  const load = async (id = sessionId) => {
    setBusy(true);
    setMessage('');
    try {
      setSessions(await store.api<RunSession[]>('/api/sessions'));
      setSummary(await store.api<SessionSummary>(`/api/sessions/${id}/summary`));
      setSessionId(id);
      setOpen(true);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="session-panel" aria-label="Session PR summary">
      <header className="narration-panel-header">
        <div className="narration-heading">
          <h3>Session PR summary</h3>
          <p>Collect run results and demos into one shareable report.</p>
        </div>
        <button className="narration-button" disabled={busy} onClick={() => void load()}>
          {busy ? 'Loading…' : open ? 'Refresh session summary' : 'Generate summary'}
        </button>
      </header>
      {open && (
        <div className="session-content">
          <label className="narration-field">
            Session
            <SelectPicker
              label="Session"
              value={sessionId}
              onChange={(value) => void load(value)}
              options={sessions.map((session) => ({ value: session.id, label: `${session.title} · ${session.jobIds.length} runs` }))}
            />
          </label>
          <details className="session-disclosure">
            <summary>Combine runs into an explicit session</summary>
            <form
              className="session-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setBusy(true);
                try {
                  const session = await store.api<RunSession>('/api/sessions', {
                    title: String(form.get('title')),
                    jobIds: form.getAll('jobs'),
                  });
                  await load(session.id);
                } catch (e) {
                  setMessage(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="narration-field">
                Session name
                <input name="title" required maxLength={160} defaultValue="Pull request verification" />
              </label>
              <div className="session-members">
                {state.jobs.map((j) => (
                  <label key={j.id}>
                    <input type="checkbox" name="jobs" value={j.id} defaultChecked={j.id === job.id} />
                    <span>
                      <strong>
                        {j.project}-{j.caseId} · {j.status}
                      </strong>
                      <small>{j.id}</small>
                    </span>
                  </label>
                ))}
              </div>
              <button className="narration-button" disabled={busy}>
                Create session summary
              </button>
            </form>
          </details>
          {summary && (
            <div className="session-preview">
              <pre className="session-markdown">{summary.markdown}</pre>
              <div className="narration-actions">
                <button
                  className="narration-button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(summary.markdown)
                      .then(() => setMessage('Summary copied.'))
                      .catch((e) => setMessage(errorMessage(e)))
                  }
                >
                  Copy Markdown
                </button>
                <a href={`/api/sessions/${sessionId}/summary?format=markdown`}>Download summary</a>
              </div>
            </div>
          )}
          <details className="session-disclosure">
            <summary>Publish to a pull request</summary>
            <div className="session-form">
              <p className="narration-help">
                Publishes this summary and selected videos to GitHub. Attachments are accessible to anyone with their URL.
              </p>
              <label className="narration-field">
                Pull request URL
                <input type="url" placeholder="https://github.com/owner/repo/pull/123" value={pr} onChange={(e) => setPr(e.target.value)} />
              </label>
              <label className="narration-field">
                Video attachments
                <SelectPicker
                  label="Video attachments"
                  value={video}
                  onChange={setVideo}
                  options={[
                    { value: 'silent', label: 'Original silent videos' },
                    { value: 'narrated', label: 'Narrated videos (must be ready)' },
                    { value: 'none', label: 'No videos' },
                  ]}
                />
              </label>
              <button
                className="primary narration-button"
                disabled={busy || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr)}
                onClick={async () => {
                  setBusy(true);
                  setMessage('');
                  try {
                    const r = await store.api<{
                      alreadyPublished?: boolean;
                      posted?: string;
                    }>('/api/publish', { sessionId, pr, publish: true, video });
                    setMessage(r.alreadyPublished ? 'This summary is already published.' : `Published: ${r.posted}`);
                  } catch (e) {
                    setMessage(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Publish session summary
              </button>
            </div>
          </details>
        </div>
      )}
      <p role="status" className="narration-message">
        {message}
      </p>
    </section>
  );
}
