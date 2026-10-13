import { useWorkspace } from '../context.tsx';
import { caseKey, modelName } from '../format.ts';
import { Icon } from './Icon.tsx';
export function Welcome() {
  const { state: s, actions: store } = useWorkspace();
  const picked = s.cases.filter((c) => s.selected.has(caseKey(c)));
  return (
    <div id="welcome" className="welcome" hidden={s.jobs.some((j) => j.id === s.activeJob)}>
      <div className="welcome-mark">
        <Icon name="check" />
      </div>
      <h1>What should we verify?</h1>
      <p>
        Select your test cases and a worktree.
        <br />
        Get a repeatable test, a clear verdict, and the video to prove it.
      </p>
      <div className="suggestions" id="suggestions">
        {!picked.length &&
          [6003, 6004, 2359]
            .map((id) => s.cases.find((c) => c.id === id))
            .filter((c) => !!c && (!c.status || c.status === 'active'))
            .map(
              (c) =>
                c && (
                  <button key={caseKey(c)} data-suggest={caseKey(c)} onClick={() => store.selectCase(caseKey(c), true)}>
                    <Icon name="play" />
                    {c.id === 6003 ? 'Multiline notes' : c.id === 6004 ? 'Note persistence' : 'Add a comment'}
                  </button>
                ),
            )}
      </div>
      <div id="selection-preview">
        {!!picked.length && (
          <div className="selected-preview">
            <div className="eyebrow">Ready to verify</div>
            {picked.map((c) => (
              <div key={caseKey(c)} className="selected-case">
                <small>{caseKey(c)}</small>
                <span>{c.title}</span>
                <button
                  className="icon-btn"
                  data-remove-case={caseKey(c)}
                  aria-label={`Remove ${caseKey(c)}`}
                  onClick={() => store.selectCase(caseKey(c))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
export function Composer() {
  const { state: s, actions: store } = useWorkspace();
  const ready = store.readyTargets(),
    count = s.selected.size * ready.length,
    environment = store.environment();
  const worktree = s.worktrees.find((w) => w.path === s.worktree);
  const disabled =
    !count ||
    ready.length !== s.targets.length ||
    !environment ||
    !s.userId ||
    (environment.kind !== 'hosted' && !s.worktree) ||
    s.submitting;
  return (
    <div className="dock">
      <div id="run-error" role="alert">
        {s.error}
      </div>
      <div className="composer">
        <div className="composer-body">
          <Icon name="case" />
          <button
            id="case-summary"
            onClick={() => {
              store.showTab('cases');
              store.patch({ sidebarOpen: true });
              requestAnimationFrame(() => document.getElementById('search')?.focus());
            }}
          >
            {s.selected.size
              ? `${s.selected.size} case${s.selected.size === 1 ? '' : 's'} selected${s.selected.size === 1 ? ' · ' + [...s.selected][0] : ''}`
              : 'Choose cases from the sidebar'}
          </button>
          <button
            id="clear-selection"
            className="icon-btn"
            aria-label="Clear selected cases"
            title="Clear selected cases"
            hidden={!s.selected.size}
            onClick={() => store.patch({ selected: new Set() })}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="composer-toolbar">
          <button
            id="model-button"
            className="control"
            aria-haspopup="dialog"
            aria-controls="model-dialog"
            title={s.targets.map((t) => `${t.provider} · ${modelName(t, s.providers)}`).join('\n') || 'Choose models'}
            onClick={() => store.patch({ dialog: 'models' })}
          >
            <Icon name="model" />
            <span id="model-label">
              {s.targets.length > 1
                ? `${s.targets.length} models`
                : s.targets.length
                  ? modelName(s.targets[0], s.providers)
                  : 'Choose model'}
            </span>
            <Icon name="chevron" className="chevron" />
          </button>
          <div className="control environment-control">
            <select
              id="environment"
              aria-label="Test environment"
              title={environment?.baseUrl ?? 'Run a local worktree'}
              value={s.environmentId}
              onChange={(e) => store.chooseEnvironment(e.target.value)}
            >
              {s.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div className="control worktree-control" title="Worktree to verify" hidden={environment?.kind === 'hosted'}>
            <Icon name="branch" />
            <select
              id="worktree"
              aria-label="Worktree to verify"
              value={s.worktree}
              title={worktree ? `${worktree.branch}\n${worktree.path}\n${worktree.subject}` : 'Select a worktree'}
              onChange={(e) => store.chooseWorktree(e.target.value)}
            >
              {s.worktrees.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.branch}
                  {w.slot ? ` · :${w.slot.port}` : ''}
                </option>
              ))}
            </select>
          </div>
          <span className="spacer" />
          <button
            id="options-open"
            className="icon-btn"
            aria-label="Run options"
            title="Run options"
            onClick={() => store.patch({ dialog: 'options' })}
          >
            <Icon name="options" />
          </button>
          <button className="primary" id="run-selected" disabled={disabled} onClick={() => void store.run()}>
            <span>{s.submitting ? 'Queuing…' : count > 1 ? `Run ${count}` : 'Run'}</span>
            <Icon name="run" />
          </button>
        </div>
      </div>
      <div className="dock-note">
        <span id="composer-hint">
          {s.selected.size && ready.length
            ? `${s.selected.size} case${s.selected.size === 1 ? '' : 's'} × ${ready.length} model${ready.length === 1 ? '' : 's'} · ${count} run${count === 1 ? '' : 's'}`
            : 'Explore → Codify → Replay'}
        </span>
        <span>⌘ Enter to run</span>
      </div>
    </div>
  );
}
