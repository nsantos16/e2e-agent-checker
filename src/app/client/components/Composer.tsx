import { providerInstanceId, targetInstanceId } from '../../../providers/schema.ts';
import { useWorkspace } from '../context.tsx';
import { caseKey, modelName } from '../format.ts';
import { Icon } from './Icon.tsx';
import { SelectPicker } from './Picker.tsx';
import type { ReactNode } from 'react';
export function Welcome({ selection }: { selection?: ReactNode } = {}) {
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
        {selection ??
          (!!picked.length && (
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
          ))}
      </div>
    </div>
  );
}
export function Composer({ unavailableReason, selectionLabel }: { unavailableReason?: string; selectionLabel?: string } = {}) {
  const { state: s, actions: store } = useWorkspace();
  const ready = s.forceFresh ? store.readyTargets() : s.targets,
    count = s.selected.size * ready.length,
    environment = store.environment();
  const worktree = s.worktrees.find((w) => w.path === s.worktree);
  const disabled =
    !!unavailableReason ||
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
            {selectionLabel ??
              (s.selected.size
                ? `${s.selected.size} case${s.selected.size === 1 ? '' : 's'} selected${s.selected.size === 1 ? ' · ' + [...s.selected][0] : ''}`
                : 'Choose cases from the sidebar')}
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
            disabled={!!unavailableReason}
            className="control"
            aria-haspopup="dialog"
            aria-controls="model-dialog"
            title={
              s.targets
                .map(
                  (t) =>
                    `${s.providers.find((p) => providerInstanceId(p) === targetInstanceId(t))?.name ?? targetInstanceId(t)} · ${modelName(t, s.providers)}`,
                )
                .join('\n') || 'Choose models'
            }
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
          <div className="environment-control">
            <SelectPicker
              id="environment"
              label="Test environment"
              className="control"
              icon="browser"
              composer
              title={
                environment
                  ? `${environment.name}${environment.baseUrl ? ` · ${environment.baseUrl}` : ' · Run a local worktree'}`
                  : 'Select an environment'
              }
              value={s.environmentId}
              onChange={store.chooseEnvironment}
              placeholder="No environments found"
              disabled={!s.environments.length}
              options={s.environments.map((e) => ({
                value: e.id,
                label: e.name,
                description: e.baseUrl ?? 'Run a local worktree',
              }))}
            />
          </div>
          <div className="worktree-control" hidden={environment?.kind === 'hosted'}>
            <SelectPicker
              id="worktree"
              label="Worktree to verify"
              className="control"
              icon="branch"
              composer
              value={s.worktree}
              disabled={!s.worktrees.length}
              title={worktree ? `${worktree.branch}\n${worktree.path}\n${worktree.subject}` : 'Select a worktree'}
              onChange={store.chooseWorktree}
              placeholder={s.worktrees.length ? 'Select a worktree' : 'No worktrees found'}
              options={s.worktrees.map((w) => ({
                value: w.path,
                label: `${w.branch}${w.slot ? ` · :${w.slot.port}` : ''}`,
                description: `${w.path}${w.subject ? ` · ${w.subject}` : ''}`,
              }))}
            />
          </div>
          <span className="spacer" />
          <button
            id="options-open"
            disabled={!!unavailableReason}
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
          {unavailableReason ?? (
            <>
              {s.mockEnabled ? 'Mocked frontend · ' : ''}
              {s.selected.size && ready.length
                ? `${s.selected.size} case${s.selected.size === 1 ? '' : 's'} × ${ready.length} model${ready.length === 1 ? '' : 's'} · ${count} run${count === 1 ? '' : 's'}`
                : 'Reuse saved spec or author a new one'}
            </>
          )}
        </span>
        <span>⌘ Enter to run</span>
      </div>
    </div>
  );
}
