import { SelectPicker } from './Picker.tsx';
import { useEffect, useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { errorMessage } from '../api.ts';
import { caseKey } from '../format.ts';
import type { AppSettings, CleanupReport, SidebarItem } from '../types.ts';
import type { SidebarGrouping } from '../workspace.ts';
import { ItemActions } from './SidebarItems.tsx';
import { Icon } from './Icon.tsx';

export function SidebarSettings() {
  const { state: s, actions: store } = useWorkspace();
  return (
    <div className="dialog-body" id="sidebar-settings" role="tabpanel" aria-labelledby="sidebar-tab">
      <h3>Organize the sidebar</h3>
      <div className="field field-stacked">
        <label htmlFor="sidebar-grouping">Group cases and runs</label>
        <SelectPicker
          id="sidebar-grouping"
          label="Group cases and runs"
          value={s.sidebarGrouping}
          onChange={(value) => store.setSidebarGrouping(value as SidebarGrouping)}
          options={[
            { value: 'project-status', label: 'Project folders + status sections' },
            { value: 'project', label: 'Project folders' },
            { value: 'status', label: 'Active / Working sections' },
            { value: 'none', label: 'Flat list' },
          ]}
        />
      </div>
      <p className="muted">
        Pinned items stay at the top. Settled items stay in their own section. Project folders show item counts and an indicator for ongoing
        runs. The combined view separates Active, Drafts and Working items inside each project.
      </p>
      <p className="muted">
        Use an item’s menu to pin, settle, archive or delete it. Drag within a section to reorder, or use Move up and Move down. Drag to
        Pinned, Active or Settled to change sections.
      </p>
      <p className="muted">
        Grouping and collapsed folders are remembered on this browser. Pins, settlement and ordering are saved in the workspace.
      </p>
    </div>
  );
}

export function ArchivedSettings() {
  const { state: s, actions: store } = useWorkspace();
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    const load = () =>
      void store
        .refreshArchive()
        .then(() => {
          if (mounted) setError('');
        })
        .catch((e) => {
          if (mounted) setError(errorMessage(e));
        })
        .finally(() => {
          if (mounted) setLoading(false);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [store]);
  const items: SidebarItem[] = [
    ...s.archivedCases.map((value) => ({ kind: 'case' as const, value })),
    ...s.archivedJobs.map((value) => ({ kind: 'run' as const, value })),
  ];
  const archivedAt = (item: SidebarItem) =>
    (item.kind === 'case' ? item.value.archivedAt : item.value.hiddenAt) ?? item.value.createdAt ?? '';
  items.sort((a, b) => archivedAt(b).localeCompare(archivedAt(a)) || String(b.value.id).localeCompare(String(a.value.id)));
  const projects = [...new Set(items.map((item) => item.value.project))].sort();
  return (
    <div className="dialog-body archive-sections" id="archived-settings" role="tabpanel" aria-labelledby="archived-tab" aria-busy={loading}>
      {!!items.length && error && <p role="alert">{error}</p>}
      {!items.length && (
        <section className="archive-section" aria-label="Archived items">
          <h3>Archived items</h3>
          <div className="archive-group">
            <div className="archive-empty" role={error ? 'alert' : 'status'}>
              <h4>
                <Icon name="archive" />
                {loading ? 'Loading archived items' : error ? 'Could not load archived items' : 'No archived items'}
              </h4>
              <p>{loading ? 'Loading cases and runs.' : error || 'Archived cases and runs will appear here.'}</p>
            </div>
          </div>
        </section>
      )}
      {projects.map((project) => (
        <section key={project} className="archive-section" aria-label={`Archived items in ${project}`}>
          <h3>
            <Icon name="folder" />
            {project}
          </h3>
          <div className="archive-group">
            {items
              .filter((item) => item.value.project === project)
              .map((item) => (
                <ArchivedRow key={`${item.kind}:${item.value.id}`} item={item} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
function ArchiveTime({ timestamp }: { timestamp?: string }) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return <>date unavailable</>;
  const seconds = Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000);
  const relative =
    seconds < 60
      ? 'just now'
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)}h ago`
          : `${Math.floor(seconds / 86400)}d ago`;
  return (
    <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
      {relative}
    </time>
  );
}
function ArchivedRow({ item }: { item: SidebarItem }) {
  const { actions: store } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const key = item.kind === 'case' ? caseKey(item.value) : `${item.value.project}-${item.value.caseId}`;
  return (
    <ItemActions item={item}>
      <div className="archived-row" data-archived-item={`${item.kind}:${item.value.id}`}>
        <div className="archived-copy">
          <h4>{item.value.title ?? key}</h4>
          <p>
            <span>
              {item.kind === 'case' ? 'Case' : 'Run'} · {key}
            </span>
            <span>
              Archived <ArchiveTime timestamp={item.kind === 'case' ? item.value.archivedAt : item.value.hiddenAt} />
              {' · Created '}
              <ArchiveTime timestamp={item.value.createdAt} />
            </span>
          </p>
          {error && <span role="alert">{error}</span>}
        </div>
        <button
          className="unarchive-button"
          disabled={busy}
          aria-label={`Unarchive ${item.kind} ${item.kind === 'case' ? caseKey(item.value) : item.value.id}`}
          onClick={() => {
            setBusy(true);
            setError('');
            void store
              .restoreItem(item)
              .catch((e) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          <Icon name="unarchive" />
          {busy ? 'Unarchiving…' : 'Unarchive'}
        </button>
      </div>
    </ItemActions>
  );
}

export function StorageSettings() {
  const { actions: store } = useWorkspace();
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [enabled, setEnabled] = useState(false),
    [days, setDays] = useState(8);
  const [report, setReport] = useState<CleanupReport | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      store.api<AppSettings>('/api/settings', undefined, controller.signal),
      store.api<CleanupReport | null>('/api/storage/cleanup', undefined, controller.signal),
    ])
      .then(([settings, latest]) => {
        setSaved(settings);
        setEnabled(settings.runCacheAfterDays !== null);
        setDays(settings.runCacheAfterDays ?? 8);
        setReport(latest);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setMessage(errorMessage(e));
      });
    return () => controller.abort();
  }, [store]);
  const dirty = saved && saved.runCacheAfterDays !== (enabled ? days : null);
  return (
    <div id="storage-settings" role="tabpanel" aria-labelledby="storage-tab">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!saved) return;
          setBusy(true);
          setMessage('');
          void store
            .api<AppSettings>('/api/settings', {
              expectedRevision: saved.revision,
              settings: { runCacheAfterDays: enabled ? days : null },
            })
            .then((settings) => {
              setSaved(settings);
              setMessage('Storage settings saved.');
            })
            .catch((e) => setMessage(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="dialog-body">
          <h3>Run cache</h3>
          <label className="retention-toggle">
            <input
              id="cache-cleanup-enabled"
              type="checkbox"
              checked={enabled}
              disabled={!saved || busy}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Automatically delete old run cache
          </label>
          <div className="field">
            <label htmlFor="cache-retention-days">
              Delete after <small>Days since the run finished. Active runs and files needed by an ongoing replay are kept.</small>
            </label>
            <input
              id="cache-retention-days"
              type="number"
              min="1"
              max="3650"
              step="1"
              required
              disabled={!enabled || busy}
              value={Number.isNaN(days) ? '' : days}
              onChange={(e) => setDays(e.target.valueAsNumber)}
            />
          </div>
          <p className="muted">
            Deletes all saved run files: videos, traces, reports, logs, saved specs and generated files. Older artifact links and saved-spec
            replay will stop working. Case definitions and result summaries are kept.
          </p>
          <p className="muted">
            Applies to completed runs, including archived and deleted runs. Cleanup runs at startup and hourly while the app is running.
            Automatic cleanup is off by default.
          </p>
          <p role="status">{message}</p>
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            disabled={busy || !saved?.runCacheAfterDays || !!dirty}
            onClick={() => {
              setBusy(true);
              setMessage('');
              void store
                .api<CleanupReport>('/api/storage/cleanup', {})
                .then((result) => {
                  setReport(result);
                  setMessage('Cleanup finished.');
                  return store.refreshJobs();
                })
                .catch((e) => setMessage(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            Delete now
          </button>
          <button type="submit" disabled={busy || !saved}>
            {busy ? 'Working…' : 'Save storage settings'}
          </button>
        </div>
      </form>
      {report && (
        <div className="dialog-body cleanup-report">
          <h3>Last cleanup</h3>
          <p>
            {new Date(report.at).toLocaleString()} · {report.removed.length} run caches cleaned · {report.skipped.length} protected ·{' '}
            {report.failed.length} failed
          </p>
          {report.failed.map((entry) => (
            <p key={entry.id} role="alert">
              {entry.id}: {entry.reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
