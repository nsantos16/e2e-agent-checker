import { useRef, type ReactNode } from 'react';
import { useWorkspace } from '../context.tsx';
import { caseKey, modelName, shortTime } from '../format.ts';
import { Icon } from './Icon.tsx';
import { SidebarGroups } from './SidebarItems.tsx';
export type SidebarExtension = {
  label: string;
  caseCount: number;
  cases: ReactNode;
  search: ReactNode;
  caseActions: ReactNode;
  footer: ReactNode;
  historyEmpty: ReactNode;
};
export function Sidebar({ extension, onNewVerification }: { extension?: SidebarExtension; onNewVerification?: () => void } = {}) {
  const { state: s, actions: store } = useWorkspace();
  const search = useRef<HTMLInputElement>(null);
  const q = s.search.toLowerCase();
  const cases = s.cases.filter((c) => !q || `${caseKey(c)} ${c.title} ${c.suite} ${(c.tags ?? []).join(' ')}`.toLowerCase().includes(q));
  const visibleJobs = s.jobs.filter((j) => !j.hiddenAt);
  const jobs = visibleJobs.filter((j) => !q || `${j.project}-${j.caseId} ${j.title} ${j.target?.model}`.toLowerCase().includes(q));
  return (
    <aside className="sidebar" aria-label="Cases and run history">
      <div className="brand">
        <span className="brand-mark">e2</span> e2e checker <small>{extension?.label ?? 'local'}</small>
      </div>
      <button
        className="new-run"
        id="new-run"
        onClick={() => {
          store.beginDraft();
          onNewVerification?.();
        }}
      >
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
          Cases <span id="case-count">{extension?.caseCount ?? s.cases.length}</span>
        </button>
        <button
          id="history-tab"
          role="tab"
          aria-selected={s.sidebarTab === 'history'}
          aria-controls="history-panel"
          data-tab="history"
          onClick={() => store.showTab('history')}
        >
          Runs <span id="history-count">{visibleJobs.length || ''}</span>
        </button>
        {extension ? (
          extension.caseActions
        ) : (
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
        )}
      </div>
      {extension ? (
        extension.search
      ) : (
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
      )}
      <div className="sidebar-body">
        <div id="case-panel" role="tabpanel" aria-labelledby="cases-tab" hidden={s.sidebarTab !== 'cases'}>
          <div id="cases">
            {extension ? (
              extension.cases
            ) : cases.length ? (
              <SidebarGroups
                items={cases.map((value) => ({ kind: 'case', value }))}
                render={(item) => {
                  if (item.kind !== 'case') return null;
                  const c = item.value,
                    key = caseKey(c),
                    latest = s.jobs.find((j) => j.project === c.project && j.caseId === c.id),
                    status = latest?.outcome ?? latest?.status;
                  const disabled = !!c.status && c.status !== 'active';
                  return (
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
                        {c.suite && (
                          <span className="case-suite" title={c.suite}>
                            {c.suite}
                          </span>
                        )}
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
                  );
                }}
              />
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
              <SidebarGroups
                items={jobs.map((value) => ({ kind: 'run', value }))}
                render={(item) => {
                  if (item.kind !== 'run') return null;
                  const j = item.value;
                  return (
                    <div className={`history-item ${j.id === s.activeJob ? 'active' : ''}`}>
                      <button
                        className="history-open"
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
                    </div>
                  );
                }}
              />
            ) : (
              <div className="empty">{extension?.historyEmpty ?? 'Your verification runs will appear here.'}</div>
            )}
          </div>
        </div>
      </div>
      <div className="sidebar-footer">
        {extension ? (
          extension.footer
        ) : (
          <>
            <button id="settings-open" className="settings-button" onClick={() => store.patch({ dialog: 'settings' })}>
              <Icon name="settings" />
              Settings
              <span
                id="connection-dot"
                className={`status-dot ${s.providers.some((p) => p.ready) ? 'ready' : ''}`}
                style={{ marginLeft: 'auto' }}
              />
            </button>
            <button
              className="icon-btn"
              aria-label="Archived items"
              title="Archived items"
              onClick={() => store.patch({ dialog: 'settings', settingsTab: 'archived' })}
            >
              <Icon name="archive" />
            </button>
          </>
        )}
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
