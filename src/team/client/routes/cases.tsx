import { createFileRoute, Link } from '@tanstack/react-router';
import { useLiveQuery, eq } from '@tanstack/react-db';
import { useForm } from '@tanstack/react-form';
import { useTable } from '@tanstack/react-table';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import {
  canEdit,
  caseDraftSchema,
  type CaseDraft,
  type TeamCase,
} from '../../contracts.ts';
import { useWorkspace } from '../context.tsx';

export const Route = createFileRoute('/cases')({
  validateSearch: z.object({
    search: z.string().max(200).catch(''),
    after: z.uuid().optional().catch(undefined),
    caseId: z
      .union([z.uuid(), z.literal('new')])
      .optional()
      .catch(undefined),
  }),
  component: Cases,
});
function Cases() {
  const { cases, actor } = useWorkspace();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const page = useSyncExternalStore(cases.subscribe, cases.getSnapshot);
  const live = useLiveQuery({
    query: (q) => q.from({ item: cases.collection }),
  });
  const rows = (live.data ?? []).filter((row) => page.ids.includes(row.id));
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
  const table = useTable({
    features: {},
    data: rows,
    getRowId: (row) => row.id,
    columns: [
      {
        accessorKey: 'title',
        header: 'Case',
        cell: (cell) => (
          <Link
            to="/cases"
            search={{ ...search, caseId: cell.row.original.id }}
          >
            {cell.row.original.title}
          </Link>
        ),
      },
      { accessorKey: 'project', header: 'Project' },
      { accessorKey: 'status', header: 'Status' },
      { accessorKey: 'revision', header: 'Revision' },
    ],
  });
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Shared catalog</p>
          <h1>Cases</h1>
          <p>Create and review the checks your team runs.</p>
        </div>
        {canEdit(actor.role) && (
          <Link
            className="button primary"
            to="/cases"
            search={{ ...search, caseId: 'new' }}
          >
            New case
          </Link>
        )}
      </header>
      <form
        className="search"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void navigate({
            search: { search: String(data.get('search') ?? '') },
          });
        }}
      >
        <label htmlFor="case-search">Find a case</label>
        <div>
          <input
            id="case-search"
            name="search"
            key={search.search}
            defaultValue={search.search}
            placeholder="Search titles"
            maxLength={200}
          />
          <button>Search</button>
        </div>
      </form>
      {page.error && (
        <p className="error" role="alert">
          {page.error}{' '}
          <button
            onClick={() => void cases.loadPage(search.search, search.after)}
          >
            Retry
          </button>
        </p>
      )}
      <div className="table-wrap" aria-busy={page.loading}>
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id}>
                    <table.FlexRender header={header} />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell) => (
                  <td key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="empty">
            {page.loading
              ? 'Loading cases…'
              : page.error
                ? 'Cases could not be loaded.'
                : 'No cases found. Create a case or adjust your search.'}
          </p>
        )}
      </div>
      <div className="pagination">
        <span>{rows.length} cases on this page</span>
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
      {search.caseId && (
        <CasePanel
          key={search.caseId}
          id={search.caseId}
          onDone={() => {
            void navigate({ search: { ...search, caseId: undefined } });
            void cases.loadPage(search.search, search.after);
          }}
        />
      )}
    </>
  );
}
function CasePanel({ id, onDone }: { id: string; onDone: () => void }) {
  const { cases, actor } = useWorkspace();
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(id === 'new');
  const [editKey, setEditKey] = useState(0);
  const live = useLiveQuery({
    query: (q) =>
      q
        .from({ item: cases.collection })
        .where(({ item }) => eq(item.id, id))
        .findOne(),
  });
  useEffect(() => {
    if (id === 'new') return;
    const release = cases.pin(id);
    let active = true;
    void cases
      .loadOne(id)
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      release();
    };
  }, [cases, id, editKey]);
  return (
    <section
      className="editor"
      aria-label={id === 'new' ? 'New case' : 'Case details'}
    >
      <header>
        <h2>
          {id === 'new' ? 'New case' : (live.data?.title ?? 'Case details')}
        </h2>
        <button onClick={onDone}>Close</button>
      </header>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : !loaded || (id !== 'new' && !live.data) ? (
        <p>Loading case…</p>
      ) : (
        <CaseEditor
          key={`${id}:${editKey}`}
          record={live.data}
          editable={canEdit(actor.role)}
          onDone={onDone}
        />
      )}
      {id !== 'new' && (
        <button
          className="quiet"
          onClick={() => {
            setLoaded(false);
            setError('');
            setEditKey((n) => n + 1);
          }}
        >
          Reload latest version
        </button>
      )}
    </section>
  );
}
function CaseEditor({
  record,
  editable,
  onDone,
}: {
  record?: TeamCase;
  editable: boolean;
  onDone: () => void;
}) {
  const { cases } = useWorkspace();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [original] = useState(record);
  const [id] = useState(() => record?.id ?? crypto.randomUUID());
  const [error, setError] = useState('');
  const defaults: CaseDraft = original ?? {
    title: '',
    project: 'LOCAL',
    description: '',
    preconditions: '',
    suitePath: '',
    priority: 0,
    severity: 0,
    tags: [],
    status: 'draft',
    steps: [],
  };
  const form = useForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      setError('');
      try {
        const data = caseDraftSchema.parse(
          Object.fromEntries(
            Object.keys(caseDraftSchema.shape).map((key) => [
              key,
              value[key as keyof CaseDraft],
            ]),
          ),
        );
        if (original) await cases.update(id, data, original.revision);
        else await cases.create(id, data);
        if (active.current) onDone();
      } catch (e) {
        setError(
          e instanceof z.ZodError
            ? e.issues.map((i) => i.message).join(' ')
            : (e as Error).message,
        );
      }
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {original && (
        <p className="muted">
          Revision {original.revision} · Updated{' '}
          {new Date(original.updatedAt).toLocaleString()}
        </p>
      )}
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(busy) => (
          <fieldset disabled={!editable || busy}>
            <form.Field name="title">
              {(field) => (
                <label>
                  Title
                  <input
                    required
                    maxLength={300}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </label>
              )}
            </form.Field>
            <div className="form-row">
              <form.Field name="project">
                {(field) => (
                  <label>
                    Project
                    <input
                      required
                      pattern="[A-Z0-9_]{1,32}"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </label>
                )}
              </form.Field>
              <form.Field name="status">
                {(field) => (
                  <div>
                    <label htmlFor="case-status">Status</label>
                    <select
                      id="case-status"
                      value={field.state.value}
                      onChange={(e) =>
                        field.handleChange(
                          e.target.value as CaseDraft['status'],
                        )
                      }
                    >
                      <option value="draft">Draft</option>
                      <option value="active">Active</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                )}
              </form.Field>
            </div>
            <form.Field name="description">
              {(field) => (
                <label>
                  Description
                  <textarea
                    rows={3}
                    maxLength={12000}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </label>
              )}
            </form.Field>
            <form.Field name="steps" mode="array">
              {(field) => (
                <div className="steps">
                  <h3>Steps</h3>
                  {field.state.value.map((_step, index) => (
                    <div className="step" key={index}>
                      <form.Field name={`steps[${index}].action`}>
                        {(action) => (
                          <label>
                            Action {index + 1}
                            <textarea
                              value={action.state.value}
                              maxLength={6000}
                              onChange={(e) =>
                                action.handleChange(e.target.value)
                              }
                            />
                          </label>
                        )}
                      </form.Field>
                      <form.Field name={`steps[${index}].expectedResult`}>
                        {(expected) => (
                          <label>
                            Expected result {index + 1}
                            <textarea
                              value={expected.state.value}
                              maxLength={6000}
                              onChange={(e) =>
                                expected.handleChange(e.target.value)
                              }
                            />
                          </label>
                        )}
                      </form.Field>
                      <button
                        type="button"
                        onClick={() => field.removeValue(index)}
                      >
                        Remove step {index + 1}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      field.pushValue({
                        action: '',
                        expectedResult: '',
                        data: '',
                      })
                    }
                  >
                    Add step
                  </button>
                </div>
              )}
            </form.Field>
          </fieldset>
        )}
      </form.Subscribe>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {editable ? (
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(busy) => (
            <button className="primary" disabled={busy}>
              {busy ? 'Saving…' : original ? 'Save changes' : 'Create case'}
            </button>
          )}
        </form.Subscribe>
      ) : (
        <p>You have read-only access.</p>
      )}
    </form>
  );
}
