import { createFileRoute } from '@tanstack/react-router';
import { useLiveQuery, eq } from '@tanstack/react-db';
import { useForm } from '@tanstack/react-form';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  canEdit,
  caseDraftSchema,
  type CaseDraft,
  type TeamCase,
} from '../../contracts.ts';
import { useWorkspace } from '../context.tsx';
import { Dialog } from '../../../app/client/components/Dialog.tsx';

export const Route = createFileRoute('/cases')({ component: Cases });
function Cases() {
  const { cases } = useWorkspace();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const close = () => {
    void navigate({ search: { ...search, caseId: undefined } });
    void cases.loadPage(search.search, search.after);
  };
  if (!search.caseId) return null;
  return (
    <Dialog
      id="team-case-dialog"
      className="team-dialog"
      title={search.caseId === 'new' ? 'New case' : 'Case details'}
      open
      onClose={close}
    >
      <div className="team-panel">
        <CasePanel key={search.caseId} id={search.caseId} onDone={close} />
      </div>
    </Dialog>
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
