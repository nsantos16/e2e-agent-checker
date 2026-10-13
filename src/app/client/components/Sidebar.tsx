import { Fragment, useRef } from 'react';
import { useWorkspace } from '../context.tsx';
import { caseKey, modelName, shortTime } from '../format.ts';
import { Icon } from './Icon.tsx';
export function Sidebar() {
  const { state: s, actions: store } = useWorkspace();
  const search = useRef<HTMLInputElement>(null);
  const q = s.search.toLowerCase();
  const cases = s.cases.filter((c) => !q || `${caseKey(c)} ${c.title} ${c.suite} ${(c.tags ?? []).join(' ')}`.toLowerCase().includes(q));
  const jobs = s.jobs.filter((j) => !q || `${j.project}-${j.caseId} ${j.title} ${j.target?.model}`.toLowerCase().includes(q));
  return (
    <aside className="sidebar" aria-label="Cases and run history">
      <div className="brand">
        <span className="brand-mark">e2</span> e2e checker <small>local</small>
      </div>
      <button className="new-run" id="new-run" onClick={() => store.beginDraft()}>
        <Icon name="plus" /> New verification <kbd>⌘ N</kbd>
      </button>
      <div className="sidebar-tabs" role="tablist" aria-label="Workspace navigation">
        <button
          id="cases-tab"
          role="tab"
          aria-selected={s.sidebarTab === 'cases'}
          aria-controls="case-panel"
          data-tab="cases"
          onClick={() => store.showTab('cases')}
        >
          Cases <span id="case-count">{s.cases.length}</span>
        </button>
        <button
          id="history-tab"
          role="tab"
          aria-selected={s.sidebarTab === 'history'}
          aria-controls="history-panel"
          data-tab="history"
          onClick={() => store.showTab('history')}
        >
          Runs <span id="history-count">{s.jobs.length || ''}</span>
        </button>
        <button
          className="icon-btn"
          id="import-open"
          title="Import a Qase case"
          aria-label="Import a Qase case"
          style={{ marginLeft: 'auto' }}
          onClick={() => store.patch({ dialog: 'import' })}
        >
          <Icon name="plus" />
        </button>
      </div>
      <div className="search-wrap">
        <Icon name="search" />
        <input
          ref={search}
          id="search"
          type="search"
          value={s.search}
          onChange={(e) => store.patch({ search: e.target.value })}
          placeholder={s.sidebarTab === 'cases' ? 'Search cases…' : 'Search runs…'}
          aria-label="Search cases or runs"
        />
        <kbd>⌘ K</kbd>
      </div>
      <div className="sidebar-body">
        <div id="case-panel" role="tabpanel" aria-labelledby="cases-tab" hidden={s.sidebarTab !== 'cases'}>
          <div id="cases">
            {cases.length ? (
              cases.map((c, index) => {
                const key = caseKey(c),
                  latest = s.jobs.find((j) => j.project === c.project && j.caseId === c.id),
                  status = latest?.outcome ?? latest?.status;
                const disabled = !!c.status && c.status !== 'active';
                return (
                  <Fragment key={key}>
                    {(index === 0 || cases[index - 1].suite !== c.suite) && <div className="suite">{c.suite || 'Workspace cases'}</div>}
                    <div className={`case ${s.selected.has(key) ? 'selected' : ''}`} data-key={key} onClick={() => store.selectCase(key)}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${key}`}
                        checked={s.selected.has(key)}
                        data-select={key}
                        disabled={disabled}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => store.selectCase(key)}
                      />
                      <div className="case-copy">
                        <span className="title" title={c.title}>
                          {c.title}
                        </span>
                        <span className="meta">
                          <span>{key}</span>
                          <span>·</span>
                          <span>{c.steps} steps</span>
                          {c.status === 'draft' && <span>· Draft</span>}
                          {latest && <span className={`status-dot ${status}`} title={status} />}
                        </span>
                      </div>
                      <button
                        className="run"
                        data-run={key}
                        aria-label={`Run ${key}`}
                        title={disabled ? 'Activate this draft through MCP to run it' : 'Run case'}
                        disabled={disabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          void store.run([key]);
                        }}
                      >
                        <Icon name="play" />
                      </button>
                    </div>
                  </Fragment>
                );
              })
            ) : (
              <div className="empty">
                No matching cases.
                <br />
                Create cases through MCP or use + to import from Qase.
              </div>
            )}
          </div>
        </div>
        <div id="history-panel" role="tabpanel" aria-labelledby="history-tab" hidden={s.sidebarTab !== 'history'}>
          <div id="history">
            {jobs.length ? (
              jobs.map((j) => (
                <button
                  key={j.id}
                  className={`history-item ${j.id === s.activeJob ? 'active' : ''}`}
                  data-open-job={j.id}
                  aria-current={j.id === s.activeJob ? 'page' : false}
                  onClick={() => void store.selectJob(j.id).catch(store.report)}
                >
                  <span className="history-title">
                    <span className={`status-dot ${j.outcome ?? j.status}`} />
                    <span>{j.title ?? `${j.project}-${j.caseId}`}</span>
                  </span>
                  <span className="history-meta">
                    <span>
                      {j.project}-{j.caseId} · {j.target ? modelName(j.target, s.providers) : 'Claude'}
                    </span>
                    <span>{shortTime(j.createdAt)}</span>
                  </span>
                </button>
              ))
            ) : (
              <div className="empty">Your verification runs will appear here.</div>
            )}
          </div>
        </div>
      </div>
      <div className="sidebar-footer">
        <button id="settings-open" className="settings-button" onClick={() => store.patch({ dialog: 'settings' })}>
          <Icon name="settings" />
          Settings{' '}
          <span
            id="connection-dot"
            className={`status-dot ${s.providers.some((p) => p.ready) ? 'ready' : ''}`}
            style={{ marginLeft: 'auto' }}
          />
        </button>
        <button
          id="theme-toggle"
          className="icon-btn"
          aria-label="Switch color theme"
          title="Switch color theme"
          onClick={store.toggleTheme}
        >
          <Icon name="theme" />
        </button>
      </div>
    </aside>
  );
}
