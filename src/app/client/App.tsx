import { useEffect, useRef } from 'react';
import { useWorkspace } from './context.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Composer, Welcome } from './components/Composer.tsx';
import { JobCard } from './components/JobCard.tsx';
import { ModelPicker } from './components/ModelPicker.tsx';
import { Settings } from './components/Settings.tsx';
import { ImportCase, RunOptions } from './components/RunDialogs.tsx';
import { Icon } from './components/Icon.tsx';
export function App() {
  const { state: s, actions: store } = useWorkspace();
  const scroll = useRef<HTMLDivElement>(null);
  const job = s.jobs.find((j) => j.id === s.activeJob);
  const worktree = s.worktrees.find((w) => w.path === s.worktree);
  const running = s.jobs.filter((j) => j.status === 'running').length,
    queued = s.jobs.filter((j) => j.status === 'queued').length;
  const title = job ? `${job.project}-${job.caseId}` : 'New verification';
  useEffect(() => {
    document.title = title + ' · e2e checker';
  }, [title]);
  useEffect(() => {
    document.documentElement.dataset.theme = s.theme;
  }, [s.theme]);
  useEffect(() => {
    document.body.classList.toggle('sidebar-open', s.sidebarOpen);
    return () => document.body.classList.remove('sidebar-open');
  }, [s.sidebarOpen]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [s.activeJob]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void store.run();
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        store.beginDraft();
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        store.patch({ sidebarOpen: true });
        requestAnimationFrame(() => document.getElementById('search')?.focus());
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [store]);
  return (
    <>
      <div className="mobile-scrim" id="sidebar-scrim" onClick={() => store.patch({ sidebarOpen: false })} />
      <div className="app">
        <Sidebar />
        <main className="workspace">
          <header className="topbar">
            <button
              id="sidebar-toggle"
              className="icon-btn"
              aria-label="Toggle sidebar"
              onClick={() => store.patch({ sidebarOpen: !s.sidebarOpen })}
            >
              <Icon name="sidebar" />
            </button>
            <span className="path">e2e-agent-checker</span>
            <span className="slash">/</span>
            <span id="view-title">{title}</span>
            <div className="right">
              <span id="running-count">{running || queued ? `${running} running · ${queued} queued` : ''}</span>
              <span
                id="slot-dot"
                className={`slot-dot ${worktree?.slot?.healthy ? 'up' : ''}`}
                title={worktree?.slot ? `Dev server on ${worktree.slot.url}` : 'Dev server starts with the run'}
              />
            </div>
          </header>
          <div className="thread-scroll" id="thread-scroll" ref={scroll}>
            <div className="content-column">
              <Welcome />
              <div id="jobs">
                {s.jobs.map((j) => (
                  <JobCard key={j.id} job={j} />
                ))}
              </div>
            </div>
          </div>
          <Composer />
        </main>
      </div>
      <ModelPicker key={s.dialog === 'models' ? 'open' : 'closed'} open={s.dialog === 'models'} />
      <Settings open={s.dialog === 'settings'} />
      <RunOptions open={s.dialog === 'options'} />
      <ImportCase open={s.dialog === 'import'} />
    </>
  );
}
