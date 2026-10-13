import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useWorkspace } from '../context.tsx';
import { useObservation } from '../useObservation.ts';
import { number, terminal } from '../format.ts';
import {
  emptyNetwork,
  filterRequests,
  requestClass,
  requestDuration,
  requestFailed,
  requestName,
  requestStatus,
  stageLabel,
  timestamp,
  type NetworkFilters,
} from '../network.ts';
import type { JobView, Network, NetworkRequest } from '../types.ts';
import { Icon } from './Icon.tsx';
const initialFilters: NetworkFilters = { filter: 'errors', query: '', type: 'all', stage: 'all', sort: 'newest' };
const detailTabs = ['overview', 'response', 'raw'] as const;
type DetailTab = (typeof detailTabs)[number];
export function ObservationPanel({ job, active }: { job: JobView; active: boolean }) {
  const { actions: store } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState(initialFilters);
  const [limit, setLimit] = useState(100);
  const [frozen, setFrozen] = useState<Network | null>(null);
  const [selected, setSelected] = useState<NetworkRequest | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [feedback, setFeedback] = useState('');
  const host = useRef<HTMLElement>(null),
    search = useRef<HTMLInputElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  const { data, error, loading } = useObservation(store.api, job.id, active, filters.filter === 'errors', limit);
  const network = frozen ?? data?.network ?? emptyNetwork;
  const all = network.requests;
  const rows = useMemo(() => filterRequests(all, filters), [all, filters]);
  const request = all.find((row) => row.id === selected?.id) ?? selected;
  const stages = [...new Set([...network.capturedStages, ...(filters.stage !== 'all' ? [filters.stage] : [])])];
  const browser = data?.browser,
    live = browser?.status === 'active' && !terminal(job);
  const uid = `observation-${job.id}`;
  const hasFilters = !!filters.query.trim() || filters.type !== 'all' || filters.stage !== 'all';
  const updateFilters = (changes: Partial<NetworkFilters>) => setFilters((current) => ({ ...current, ...changes }));
  const changeFilter = (filter: NetworkFilters['filter']) => {
    setFrozen(null);
    updateFilters({ filter });
  };
  const select = (row: NetworkRequest) => {
    setSelected(row);
    setFeedback('');
  };
  const focusRow = (id: string) =>
    Array.from(host.current?.querySelectorAll<HTMLTableRowElement>('[data-request]') ?? [])
      .find((row) => row.dataset.request === id)
      ?.querySelector<HTMLButtonElement>('button')
      ?.focus({ preventScroll: true });
  const closeDetail = () => {
    if (selected) focusRow(selected.id);
    setSelected(null);
  };
  const close = () => {
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
  };
  const keyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement,
      tab = target.closest<HTMLButtonElement>('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      const current = detailTabs.indexOf(tab.dataset.networkDetailTab as DetailTab);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (current + (e.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
      e.preventDefault();
      setDetailTab(detailTabs[next]);
      host.current?.querySelector<HTMLButtonElement>(`[data-network-detail-tab="${detailTabs[next]}"]`)?.focus();
    } else if (target.closest('[data-request]') && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
      const index = rows.findIndex((row) => row.id === target.closest<HTMLElement>('[data-request]')?.dataset.request);
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        e.preventDefault();
        select(next);
        focusRow(next.id);
      }
    } else if (e.key === 'Escape' && request) {
      e.preventDefault();
      e.stopPropagation();
      closeDetail();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const copy = async (kind: 'url' | 'details') => {
    if (!request) return;
    try {
      await navigator.clipboard.writeText(kind === 'url' ? request.url : JSON.stringify(request, null, 2));
      setFeedback('Copied');
    } catch {
      setFeedback('Copy unavailable. Select text in Raw.');
    }
  };
  return (
    <section
      ref={host}
      className="observation"
      aria-label="Browser and network evidence"
      hidden={!error && terminal(job) && !browser && !network.capturedStages.length}
      data-network-open={String(open)}
      onKeyDown={keyDown}
    >
      <div className="observation-controls">
        <span className="observation-control">
          <Icon name="browser" />
          Browser
        </span>
        <button
          ref={toggle}
          className="observation-control"
          data-network-toggle
          aria-controls={`${uid}-network`}
          aria-expanded={open}
          onClick={() => {
            if (open) close();
            else {
              setOpen(true);
              requestAnimationFrame(() => search.current?.focus({ preventScroll: true }));
            }
          }}
        >
          <Icon name="network" />
          Network{' '}
          <span className="network-badge" hidden={!network.errorCount}>
            {number(network.errorCount)}
          </span>
        </button>
        <span className="capture-state">
          <span className={`status-dot ${live ? 'ready' : ''}`} />
          <span className="capture-label">{live ? 'Capturing' : !terminal(job) ? 'Between stages' : 'Capture complete'}</span>
        </span>
      </div>
      <div className="observation-error" role="status" hidden={!error}>
        {error}
      </div>
      <div className="browser-pane" id={`${uid}-browser`}>
        <div className="observation-head">
          <span className={`status-dot live-dot ${live ? 'ready' : ''}`} />
          <strong className="live-label">
            {live ? 'Live browser' : browser?.status === 'stale' ? 'Preview paused' : browser?.frameAt ? 'Last browser frame' : 'Browser'}
          </strong>
          <small>Read only · 1s refresh</small>
        </div>
        <img
          className="live-frame"
          alt="Latest frame from the verification browser"
          hidden={!browser?.frameAt}
          src={browser?.frameAt ? `/api/jobs/${job.id}/frame?t=${encodeURIComponent(browser.frameAt)}` : undefined}
          data-frame={browser?.frameAt}
        />
        <div className="live-waiting" hidden={!!browser?.frameAt}>
          {terminal(job) ? 'No browser preview was captured.' : 'Waiting for the browser to open…'}
        </div>
        <div className="live-caption">
          {browser
            ? `${browser.stage} · ${browser.pageUrl ?? 'Opening page…'}${live ? '' : browser.status === 'stale' ? ' · Waiting for a fresh frame' : ' · Browser session ended'}`
            : ''}
        </div>
      </div>
      <aside className="network-pane" id={`${uid}-network`} aria-labelledby={`${uid}-network-title`} hidden={!open}>
        <header className="network-panel-head">
          <Icon name="network" />
          <strong id={`${uid}-network-title`}>Network</strong>
          <small>
            {job.project} {job.caseId}
          </small>
          <button className="icon-btn" data-network-dismiss aria-label="Close network panel" onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        <div className="network-toolbar">
          <div className="network-segments" role="group" aria-label="Filter requests">
            <button data-network-filter="all" aria-pressed={filters.filter === 'all'} onClick={() => changeFilter('all')}>
              All <span data-count="all">{number(network.total)}</span>
            </button>
            <button data-network-filter="errors" aria-pressed={filters.filter === 'errors'} onClick={() => changeFilter('errors')}>
              Errors <span data-count="errors">{number(network.errorCount)}</span>
            </button>
            <button
              data-network-filter="slow"
              aria-pressed={filters.filter === 'slow'}
              title="Requests taking one second or longer"
              onClick={() => changeFilter('slow')}
            >
              Slow ≥1s
            </button>
          </div>
          <div className="network-actions">
            <button
              className="network-action"
              data-network-pause
              aria-pressed={!!frozen}
              title="Freeze this request list. Capture continues."
              onClick={() => setFrozen((current) => (current ? null : (structuredClone(network) as Network)))}
            >
              <Icon name={frozen ? 'play' : 'pause'} />
              {frozen ? 'Resume feed' : 'Pause feed'}
            </button>
            <a
              className="network-action"
              href={`/api/jobs/${job.id}/network?errorsOnly=0&limit=500&download=1`}
              title="Download up to 500 retained requests as sanitized JSON"
            >
              <Icon name="download" />
              Export JSON
            </a>
          </div>
        </div>
        <div className="network-filters">
          <label className="network-search">
            <Icon name="search" />
            <input
              ref={search}
              type="search"
              data-network-search
              placeholder="Filter URL, method or request ID…"
              aria-label="Search loaded network requests"
              value={filters.query}
              onChange={(e) => updateFilters({ query: e.target.value })}
            />
          </label>
          <select
            data-network-type
            aria-label="Request type"
            value={filters.type}
            onChange={(e) => updateFilters({ type: e.target.value })}
          >
            {[
              ['all', 'All types'],
              ['api', 'Fetch / XHR'],
              ['document', 'Document'],
              ['script', 'Script'],
              ['stylesheet', 'Stylesheet'],
              ['image', 'Image'],
              ['font', 'Font'],
              ['other', 'Other'],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            data-network-stage
            aria-label="Capture stage"
            value={filters.stage}
            onChange={(e) => updateFilters({ stage: e.target.value })}
          >
            <option value="all">All stages</option>
            {stages.map((stage) => (
              <option key={stage} value={stage}>
                {stageLabel(stage)}
              </option>
            ))}
          </select>
          <select
            data-network-sort
            aria-label="Sort requests"
            value={filters.sort}
            onChange={(e) => updateFilters({ sort: e.target.value })}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="slowest">Slowest first</option>
          </select>
        </div>
        <div className={`network-split ${request ? 'has-selection' : ''}`}>
          <div className="network-table-scroll">
            <RequestTable rows={rows} all={all} selected={request?.id} detailId={`${uid}-detail`} onSelect={select} />
            <div className="network-empty" hidden={!!rows.length}>
              <Icon name={hasFilters ? 'search' : 'network'} />
              <strong>
                {!network.capturedStages.length
                  ? 'Waiting for network activity'
                  : hasFilters
                    ? 'No matching requests'
                    : filters.filter === 'errors'
                      ? 'No network errors'
                      : filters.filter === 'slow'
                        ? 'No slow requests'
                        : 'No requests captured'}
              </strong>
              <p>
                {!network.capturedStages.length
                  ? 'Requests will appear when the browser opens.'
                  : 'Try another filter or load more of the retained capture.'}
              </p>
            </div>
          </div>
          <aside className="network-detail" aria-label="Selected request" hidden={!request}>
            {request && (
              <>
                <div className="network-detail-head">
                  <div className="network-detail-title">
                    <strong>Request details</strong>
                    <span className={`network-status ${requestClass(request)}`}>
                      {request.method} {requestStatus(request)}
                    </span>
                    <button data-network-close aria-label="Close request details" onClick={closeDetail}>
                      <Icon name="close" />
                    </button>
                  </div>
                  <h3 className="network-detail-name">{requestName(request).path}</h3>
                </div>
                <div className="network-detail-tabs" role="tablist" aria-label="Request details">
                  {detailTabs.map((tab) => (
                    <button
                      key={tab}
                      role="tab"
                      id={`${uid}-${tab}-tab`}
                      aria-controls={`${uid}-detail`}
                      data-network-detail-tab={tab}
                      aria-selected={detailTab === tab}
                      tabIndex={detailTab === tab ? 0 : -1}
                      onClick={() => setDetailTab(tab)}
                    >
                      {tab[0].toUpperCase() + tab.slice(1)}
                    </button>
                  ))}
                </div>
                <div className="network-detail-body" id={`${uid}-detail`} role="tabpanel" aria-labelledby={`${uid}-${detailTab}-tab`}>
                  <RequestDetail request={request} tab={detailTab} outsideFilter={!rows.some((row) => row.id === request.id)} />
                </div>
                <div className="network-detail-foot">
                  <button className="network-action" data-network-copy="details" onClick={() => void copy('details')}>
                    <Icon name="copy" />
                    Copy details
                  </button>
                  <button className="network-action" data-network-copy="url" onClick={() => void copy('url')}>
                    Copy URL
                  </button>
                  <span className="network-copy-feedback" role="status">
                    {feedback}
                  </span>
                </div>
              </>
            )}
          </aside>
        </div>
        <div className="network-footer">
          <span className="network-count">
            {rows.length} shown · {all.length} loaded{network.matching > all.length ? ` of ${number(network.matching)} retained` : ''}
            {frozen ? ' · Feed paused' : ''}
          </span>
          <button
            data-network-more
            hidden={limit >= 500 || network.matching <= all.length || !!frozen}
            disabled={loading}
            onClick={() => setLimit((current) => Math.min(500, current + 100))}
          >
            Load more
          </button>
          <button
            data-network-clear
            hidden={!hasFilters && filters.filter === 'all'}
            onClick={() => {
              setFilters({ ...initialFilters, filter: 'all' });
              setFrozen(null);
            }}
          >
            Clear filters
          </button>
        </div>
        <div className="network-note">
          <Icon name="shield" />
          <span>
            Sanitized capture. Request bodies and sensitive headers are not collected.
            {network.dropped ? ` ${number(network.dropped)} requests were omitted by the retention limit.` : ''}
            {network.matching > all.length ? ' Filters apply to loaded requests.' : ''} Timing bars are relative to the loaded capture.
          </span>
        </div>
      </aside>
    </section>
  );
}
function RequestTable({
  rows,
  all,
  selected,
  detailId,
  onSelect,
}: {
  rows: NetworkRequest[];
  all: NetworkRequest[];
  selected?: string;
  detailId: string;
  onSelect: (request: NetworkRequest) => void;
}) {
  const dated = all.filter((row) => timestamp(row) > 0),
    origin = dated.length ? Math.min(...dated.map(timestamp)) : 0;
  const span = Math.max(1, ...dated.map((row) => timestamp(row) - origin + Math.max(0, row.durationMs ?? 0)));
  return (
    <table className="network-table" aria-label="Captured network requests">
      <thead>
        <tr>
          <th scope="col">Request</th>
          <th scope="col">Status</th>
          <th scope="col">Time</th>
          <th scope="col" className="waterfall-column" title="Start and duration within the loaded capture window">
            Timing
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const name = requestName(row),
            left = Math.max(0, Math.min(99, ((timestamp(row) - origin) / span) * 100)),
            width = Math.max(0.8, Math.min(100 - left, ((row.durationMs ?? 0) / span) * 100));
          const slow = (row.durationMs ?? 0) >= 1000;
          return (
            <tr
              key={row.id}
              data-request={row.id}
              className={`network-request ${selected === row.id ? 'selected' : ''}`}
              onClick={() => onSelect(row)}
            >
              <td>
                <button className="network-request-name" aria-expanded={selected === row.id} aria-controls={detailId}>
                  <span className="request-method">{row.method}</span>
                  <span className="request-name-stack">
                    <strong title={row.url}>{name.name}</strong>
                    <small title={row.url}>{name.host + name.path.replace(/\/[^/]*$/, '/')}</small>
                  </span>
                </button>
              </td>
              <td>
                <span
                  className={`network-status ${requestClass(row)}`}
                  title={
                    row.failure ??
                    (row.incomplete
                      ? 'Request did not finish before capture ended'
                      : row.status == null
                        ? 'Request in progress'
                        : `HTTP ${row.status}`)
                  }
                >
                  {requestStatus(row)}
                </span>
              </td>
              <td className={`network-duration ${slow ? 'slow' : ''}`}>{requestDuration(row)}</td>
              <td className="waterfall-column">
                <div
                  className="network-waterfall"
                  title={
                    timestamp(row)
                      ? `+${((timestamp(row) - origin) / 1000).toFixed(2)}s in loaded capture · ${requestDuration(row)}`
                      : 'Timing not captured'
                  }
                >
                  {!!timestamp(row) && (
                    <span
                      className={requestFailed(row) ? 'bad' : slow ? 'slow' : row.durationMs == null ? 'pending' : ''}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
function JsonView({ value }: { value: unknown }) {
  const raw = JSON.stringify(value, null, 2) ?? 'null';
  return (
    <pre>
      {raw.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g).map((part, i) => {
        const kind = /^".*:\s*$/.test(part)
          ? 'key'
          : part.startsWith('"')
            ? 'string'
            : /^(true|false|null)$/.test(part)
              ? 'literal'
              : /^-?\d/.test(part)
                ? 'number'
                : null;
        return kind ? (
          <span key={i} className={`json-${kind}`}>
            {part}
          </span>
        ) : (
          part
        );
      })}
    </pre>
  );
}
function Fields({ entries }: { entries: [string, ReactNode, boolean?][] }) {
  return (
    <dl>
      {entries.map(([label, value, mono]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd className={mono ? 'mono' : undefined}>{value ?? 'Not captured'}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
function RequestDetail({ request: r, tab, outsideFilter }: { request: NetworkRequest; tab: DetailTab; outsideFilter: boolean }) {
  if (tab === 'raw') return <JsonView value={r} />;
  if (tab === 'response')
    return r.errorBody != null ? (
      <>
        <h4>Sanitized error response</h4>
        <JsonView value={r.errorBody} />
      </>
    ) : (
      <div className="network-empty">
        <Icon name="network" />
        <strong>No response body captured</strong>
        <p>{r.bodyNote ?? 'Only small JSON error responses are retained. Successful response bodies are not collected.'}</p>
      </div>
    );
  const message =
    r.errorBody && typeof r.errorBody === 'object' && 'message' in r.errorBody ? String(r.errorBody.message).slice(0, 200) : '';
  return (
    <>
      {r.failure ? (
        <div className="network-detail-error">{r.failure}</div>
      ) : (
        requestFailed(r) && (
          <div className="network-detail-error">
            HTTP {r.status} response{message ? ` · ${message}` : ''}
          </div>
        )
      )}
      {outsideFilter && <p className="network-copy-feedback">Selected request is outside the current filter.</p>}
      <h4>General</h4>
      <Fields
        entries={[
          ['URL', r.url, true],
          ['Method', r.method],
          ['Status', r.status == null ? (r.failure ? 'Transport failure' : r.incomplete ? 'Incomplete' : 'Pending') : `HTTP ${r.status}`],
          ['Duration', requestDuration(r)],
          ['Type', r.resourceType],
          ['Started', r.at ? new Date(r.at).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 }) : null],
        ]}
      />
      <h4>Run context</h4>
      <Fields
        entries={[
          ['Stage', stageLabel(r.stage)],
          ['Action', r.action],
          ['Content type', r.contentType],
          ['Request ID', r.requestId, true],
          ['Trace ID', r.traceId, true],
        ]}
      />
    </>
  );
}
