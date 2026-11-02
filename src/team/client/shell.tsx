import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import { useLiveQuery } from '@tanstack/react-db';
import { App } from '../../app/client/App.tsx';
import { useWorkspace as useAppWorkspace } from '../../app/client/context.tsx';
import { Icon } from '../../app/client/components/Icon.tsx';
import { useWorkspace } from './context.tsx';
import { canEdit } from '../contracts.ts';

export function TeamShell() {
  const { actor, cases } = useWorkspace();
  const { state, actions } = useAppWorkspace();
  const search = useSearch({ from: '__root__' });
  const navigate = useNavigate();
  const page = useSyncExternalStore(cases.subscribe, cases.getSnapshot);
  const live = useLiveQuery({
    query: (q) => q.from({ item: cases.collection }),
  });
  const records = live.data ?? [];
  const byId = new Map(records.map((row) => [row.id, row]));
  const rows = page.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const selected = records.filter(
    (row) => state.selected.has(row.id) && row.status === 'active',
  );
  const [query, setQuery] = useState(search.search);
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(typing.current);
    setQuery(search.search);
  }, [search.search, search.after]);
  useEffect(() => () => clearTimeout(typing.current), []);
  useEffect(() => {
    const refresh = () => {
      void cases.loadPage(search.search, search.after);
    };
    refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [cases, search.search, search.after]);
  useEffect(() => {
    const release = [...state.selected].map((id) => cases.pin(id));
    return () => release.forEach((fn) => fn());
  }, [cases, state.selected]);
  useEffect(() => {
    if (selected.length !== state.selected.size)
      actions.patch({ selected: new Set(selected.map((row) => row.id)) });
  }, [actions, selected, state.selected]);
  const toggle = (id: string) => {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    actions.patch({ selected: next });
  };
  const home = useCallback(() => {
    clearTimeout(typing.current);
    actions.patch({ sidebarOpen: false });
    void navigate({ to: '/', search: { search: '' } });
  }, [actions, navigate]);
  const applySearch = (value: string, replace = false) => {
    clearTimeout(typing.current);
    actions.showTab('cases');
    void navigate({ to: '/cases', search: { search: value }, replace });
  };
  return (
    <App
      onNewVerification={home}
      executionUnavailable="Run verifications in the local app. Team worker connection is not available yet."
      selectionLabel={selected.length === 1 ? selected[0].title : undefined}
      selection={
        selected.length ? (
          <div className="selected-preview">
            <div className="eyebrow">Selected cases</div>
            {selected.map((row) => (
              <div className="selected-case" key={row.id}>
                <small>{row.project}</small>
                <span>{row.title}</span>
                <button
                  className="icon-btn"
                  aria-label={`Remove ${row.title}`}
                  onClick={() => toggle(row.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null
      }
      sidebar={{
        label: 'team',
        caseCount: rows.length,
        caseActions: canEdit(actor.role) ? (
          <Link
            className="icon-btn team-new-case"
            aria-label="New case"
            title="New case"
            to="/cases"
            search={{ ...search, caseId: 'new' }}
          >
            <Icon name="plus" />
          </Link>
        ) : null,
        search: (
          <form
            className="search-wrap"
            onSubmit={(event) => {
              event.preventDefault();
              applySearch(query);
            }}
          >
            <Icon name="search" />
            <input
              id="search"
              type="search"
              aria-label="Search cases or runs"
              placeholder="Search cases…"
              maxLength={200}
              value={query}
              onChange={(event) => {
                const value = event.target.value;
                setQuery(value);
                clearTimeout(typing.current);
                typing.current = setTimeout(
                  () => applySearch(value, true),
                  250,
                );
              }}
            />
            <kbd>⌘ K</kbd>
          </form>
        ),
        cases: (
          <div aria-label="Shared cases" role="region" aria-busy={page.loading}>
            {page.error && (
              <div className="empty" role="alert">
                {page.error}{' '}
                <button
                  onClick={() =>
                    void cases.loadPage(search.search, search.after)
                  }
                >
                  Retry
                </button>
              </div>
            )}
            {rows.map((row) => (
              <div
                className={`case ${state.selected.has(row.id) ? 'selected' : ''}`}
                key={row.id}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${row.title}`}
                  disabled={row.status !== 'active'}
                  checked={state.selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                />
                <div className="case-copy">
                  <Link
                    className="title"
                    title={row.title}
                    to="/cases"
                    search={{ ...search, caseId: row.id }}
                  >
                    {row.title}
                  </Link>
                  <span className="meta">
                    <span>{row.project}</span>
                    <span>· {row.steps.length} {row.steps.length === 1 ? 'step' : 'steps'}</span>
                    <span>· {row.status}</span>
                    <span>· r{row.revision}</span>
                  </span>
                </div>
              </div>
            ))}
            {!rows.length && !page.error && (
              <div className="empty">
                {page.loading
                  ? 'Loading cases…'
                  : 'No cases found. Adjust your search or create a case.'}
              </div>
            )}
            <div className="team-pagination">
              <span>
                {rows.length} {rows.length === 1 ? 'case' : 'cases'} on this
                page
              </span>
              {search.after && (
                <Link to="/cases" search={{ search: search.search }}>
                  First page
                </Link>
              )}
              {page.nextCursor && (
                <Link
                  to="/cases"
                  search={{ search: search.search, after: page.nextCursor }}
                >
                  Next page
                </Link>
              )}
            </div>
          </div>
        ),
        historyEmpty:
          'Shared run history will appear here when team workers are connected. Your local runs remain in the local app.',
        footer: (
          <>
            <Link
              className="settings-button"
              to="/account"
              search={search}
              title={`${actor.name} · ${actor.role} in ${actor.organizationName}`}
            >
              <Icon name="settings" />
              Account
            </Link>
          </>
        ),
      }}
      overlays={<Outlet />}
    />
  );
}
