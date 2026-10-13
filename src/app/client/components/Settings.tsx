import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { errorMessage } from '../api.ts';
import { providerMark, providerMessage } from '../format.ts';
import type { Check, Environment, TestUser } from '../types.ts';
import { Dialog, DialogHeader } from './Dialog.tsx';
export function Settings({ open }: { open: boolean }) {
  const { state: s, actions: store } = useWorkspace();
  const [tab, setTab] = useState<'connections' | 'environments'>('connections');
  const [checks, setChecks] = useState<Check[]>([]);
  const close = () => store.patch({ dialog: null });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void store
      .api<Check[]>(
        '/api/doctor?' + new URLSearchParams({ environmentId: s.environmentId || 'local', ...(s.userId ? { userId: s.userId } : {}) }),
        undefined,
        controller.signal,
      )
      .then(setChecks)
      .catch((e) => {
        if (!controller.signal.aborted) store.report(e);
      });
    return () => controller.abort();
  }, [store, open, s.environmentId, s.userId]);
  const missing = checks.filter((c) => !c.ok && c.required);
  return (
    <Dialog open={open} id="settings-dialog" className="settings-dialog" title="Settings" onClose={close}>
      <DialogHeader id="settings-dialog" onClose={close}>
        Settings
      </DialogHeader>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {(['connections', 'environments'] as const).map((name) => (
          <button
            key={name}
            role="tab"
            id={`${name}-tab`}
            data-settings-tab={name}
            aria-controls={`${name}-settings`}
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name === 'connections' ? 'Connections' : 'Environments'}
          </button>
        ))}
      </div>
      <div id="connections-settings" role="tabpanel" aria-labelledby="connections-tab" hidden={tab !== 'connections'}>
        <div className="dialog-body">
          <p className="muted" style={{ fontSize: 12, margin: '0 0 20px' }}>
            Use your existing developer subscriptions. Each runtime keeps its own sign-in.
          </p>
          <div id="providers">
            {s.providers.map((p) => (
              <div key={p.id} className="provider-setting">
                <div className="provider-setting-head">
                  <span className="brand-mark">{providerMark[p.id]}</span>
                  <strong>{p.name}</strong>
                  <span className={`chip ${p.ready ? 'pass' : p.auth === 'api-key' ? 'blocked' : ''}`}>
                    {p.ready ? 'Connected' : p.auth === 'api-key' ? 'API key active' : p.installed ? 'Unavailable' : 'Not installed'}
                  </span>
                </div>
                <p>{providerMessage(p)}</p>
                {!p.ready && (p.id !== 'cursor' || p.auth !== 'subscription') && <code>{p.loginCommand}</code>}
              </div>
            ))}
          </div>
          <div id="doctor">
            {!!missing.length && (
              <>
                <h3>Workspace setup</h3>
                <ul>
                  {missing.map((c) => (
                    <li key={c.name}>
                      {c.name}: {c.detail}
                      <br />
                      <code>{c.fix}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <span>Credentials stay with their provider.</span>
          <button id="refresh-providers" disabled={s.refreshingProviders} onClick={() => void store.refreshProviders().catch(store.report)}>
            Refresh connections
          </button>
        </div>
      </div>
      {tab === 'environments' && <EnvironmentSettings />}
    </Dialog>
  );
}
function EnvironmentSettings() {
  const { actions: store } = useWorkspace();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [editing, setEditing] = useState<Environment | null | undefined>(undefined);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (preferred?: string) => {
      const values = await store.api<Environment[]>('/api/environments?detail=1', undefined, controller.current?.signal);
      setEnvironments(values);
      store.setEnvironments(values);
      setEditing(values.find((e) => e.id === preferred) ?? values[0] ?? null);
      setVersion((v) => v + 1);
    },
    [store],
  );
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void load().catch((e) => {
      if (!abort.signal.aborted) setMessage(errorMessage(e));
    });
    return () => abort.abort();
  }, [load]);
  const save = async (environment: Environment) => {
    setBusy(true);
    setMessage('Saving…');
    try {
      await store.api(
        '/api/environments',
        { environment, ...(editing ? { expectedRevision: editing.revision } : {}) },
        controller.current?.signal,
      );
      await load(environment.id);
      setMessage('Environment saved. Choose it in the run controls.');
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await store.api(
        `/api/environments/${encodeURIComponent(editing.id)}/delete`,
        { expectedRevision: editing.revision },
        controller.current?.signal,
      );
      await load();
      setMessage('Environment deleted. Past run evidence is retained.');
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id="environments-settings" role="tabpanel" aria-labelledby="environments-tab">
      <div className="dialog-body">
        <div className="environment-heading">
          <p>Choose where tests run and which accounts they use.</p>
          <button
            type="button"
            id="new-environment"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setVersion((v) => v + 1);
              setMessage('');
            }}
          >
            + Environment
          </button>
        </div>
        <div id="environment-list" className="environment-list">
          {environments.map((e) => (
            <button
              key={e.id}
              type="button"
              data-edit-environment={e.id}
              aria-pressed={editing?.id === e.id}
              disabled={busy}
              onClick={() => {
                setEditing(e);
                setVersion((v) => v + 1);
                setMessage('');
              }}
            >
              <strong>{e.name}</strong>
              <small>
                {e.kind === 'hosted' ? 'Hosted URL' : 'Local worktree'} · {e.users.length} {e.users.length === 1 ? 'user' : 'users'}
              </small>
            </button>
          ))}
        </div>
        {editing !== undefined && <EnvironmentForm key={version} environment={editing} busy={busy} save={save} remove={remove} />}
        <div id="environment-message" role="status">
          {message}
        </div>
      </div>
    </div>
  );
}
function EnvironmentForm({
  environment,
  busy,
  save,
  remove,
}: {
  environment: Environment | null;
  busy: boolean;
  save: (environment: Environment) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const [kind, setKind] = useState(environment?.kind ?? 'hosted');
  const [users, setUsers] = useState(() =>
    (environment?.users ?? [{ id: '', name: '' }]).map((user) => ({ key: crypto.randomUUID(), user })),
  );
  // Uncontrolled form fields preserve in-progress edits until this editor's revision changes.
  return (
    <form
      id="environment-form"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const read = (name: string) => String(data.get(name) ?? '').trim();
        void save({
          id: read('id'),
          name: read('name'),
          kind,
          ...(kind === 'hosted' ? { baseUrl: read('baseUrl') } : { devMode: read('devMode') }),
          users: users.map(({ key }) => ({
            id: read(key + '.id'),
            name: read(key + '.name'),
            usernameRef: read(key + '.usernameRef'),
            passwordRef: read(key + '.passwordRef'),
            ...(read(key + '.totpRef') ? { totpRef: read(key + '.totpRef') } : {}),
          })),
        });
      }}
    >
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="environment-fields">
          <label>
            Name
            <input
              id="environment-name"
              name="name"
              required
              placeholder="Staging"
              maxLength={100}
              defaultValue={environment?.name ?? ''}
              autoFocus={!environment}
            />
          </label>
          <label>
            ID
            <input
              id="environment-id"
              name="id"
              required
              pattern="[a-z0-9][a-z0-9_-]{0,63}"
              placeholder="staging"
              defaultValue={environment?.id ?? ''}
              readOnly={!!environment}
            />
          </label>
          <label>
            Target
            <select id="environment-kind" value={kind} onChange={(e) => setKind(e.target.value as Environment['kind'])}>
              <option value="hosted">Hosted URL</option>
              <option value="worktree">Local worktree</option>
            </select>
          </label>
          <label id="environment-url-field" hidden={kind !== 'hosted'}>
            Base URL
            <input
              id="environment-url"
              name="baseUrl"
              type="url"
              placeholder="https://staging.example.com"
              required={kind === 'hosted'}
              defaultValue={environment?.baseUrl ?? ''}
            />
          </label>
          <label id="environment-mode-field" hidden={kind === 'hosted'}>
            Development mode
            <input
              id="environment-mode"
              name="devMode"
              placeholder="ci.development"
              pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}"
              required={kind === 'worktree'}
              defaultValue={environment?.devMode ?? 'ci.development'}
            />
          </label>
        </div>
        <div className="environment-heading">
          <strong>Test users</strong>
          <button
            type="button"
            id="add-test-user"
            onClick={() => setUsers((rows) => [...rows, { key: crypto.randomUUID(), user: { id: '', name: '' } }])}
          >
            + User
          </button>
        </div>
        <p className="environment-help">
          Use 1Password references such as <code>op://vault/item/password</code>, or <code>env://STAGING_PASSWORD</code> for variables
          available to the checker. Secret values are never shown here.
        </p>
        <div id="test-user-list">
          {users.map(({ key, user }) => (
            <TestUserFields key={key} fieldKey={key} user={user} remove={() => setUsers((rows) => rows.filter((row) => row.key !== key))} />
          ))}
        </div>
        <div className="environment-save">
          <button type="button" id="delete-environment" hidden={!environment || environment.id === 'local'} onClick={() => void remove()}>
            Delete environment
          </button>
          <button className="primary" type="submit">
            Save environment
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function TestUserFields({ fieldKey, user, remove }: { fieldKey: string; user: TestUser; remove: () => void }) {
  return (
    <section className="test-user-card">
      <div className="environment-heading">
        <strong>Test user</strong>
        <button type="button" data-remove-user aria-label="Remove test user" onClick={remove}>
          Remove
        </button>
      </div>
      <div className="environment-fields">
        {(
          [
            ['name', 'Name', 'QA administrator'],
            ['id', 'User ID', 'admin'],
            ['usernameRef', 'Username reference', 'env://STAGING_USERNAME'],
            ['passwordRef', 'Password reference', 'op://vault/item/password'],
            ['totpRef', 'One-time code reference (optional)', 'op://vault/item/one-time password?attribute=otp'],
          ] as const
        ).map(([key, label, placeholder]) => (
          <label key={key}>
            {label}
            <input
              name={fieldKey + '.' + key}
              data-user-field={key}
              defaultValue={user[key] ?? ''}
              placeholder={placeholder}
              required={key !== 'totpRef'}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
