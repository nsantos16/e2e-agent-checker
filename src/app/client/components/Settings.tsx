import { ProviderSettings } from './ProviderSettings.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { errorMessage } from '../api.ts';
import type { Check, Environment, TestUser } from '../types.ts';
import { Dialog, DialogHeader } from './Dialog.tsx';
import { ArchivedSettings, SidebarSettings, StorageSettings } from './ManagementSettings.tsx';
import { Icon } from './Icon.tsx';
const sections = [
  { id: 'connections', name: 'Providers', icon: 'model' },
  { id: 'environments', name: 'Environments', icon: 'browser' },
  { id: 'sidebar', name: 'Sidebar', icon: 'sidebar' },
  { id: 'archived', name: 'Archived', icon: 'archive' },
  { id: 'storage', name: 'Storage', icon: 'options' },
] as const;
export function Settings({ open }: { open: boolean }) {
  const { state: s, actions: store } = useWorkspace();
  const tab = s.settingsTab;
  const [checks, setChecks] = useState<Check[]>([]);
  const close = () => store.patch({ dialog: null });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void store
      .api<Check[]>(
        '/api/doctor?' +
          new URLSearchParams({
            environmentId: s.environmentId || 'local',
            ...(s.userId ? { userId: s.userId } : {}),
          }),
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
      <div className="settings-layout">
        <div className="settings-navigation">
          <div className="settings-tabs" role="tablist" aria-label="Settings sections">
            {sections.map(({ id: name, name: label, icon }, index) => (
              <button
                key={name}
                role="tab"
                id={`${name}-tab`}
                data-settings-tab={name}
                aria-controls={`${name}-settings`}
                aria-selected={tab === name}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => store.patch({ settingsTab: name })}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    sections[
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? sections.length - 1
                          : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + sections.length) % sections.length
                    ].id;
                  store.patch({ settingsTab: next });
                  document.getElementById(`${next}-tab`)?.focus();
                }}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
          <span className="settings-local-note">On this machine</span>
        </div>
        <div className="settings-content">
          <div
            id="connections-settings"
            className="settings-panel"
            role="tabpanel"
            aria-labelledby="connections-tab"
            hidden={tab !== 'connections'}
          >
            <div className="dialog-body">
              <ProviderSettings />
            </div>
            <div className="dialog-actions">
              <span>Credentials stay with their provider.</span>
              <button
                id="refresh-providers"
                disabled={s.refreshingProviders}
                onClick={() => void store.refreshProviders().catch(store.report)}
              >
                {s.refreshingProviders ? 'Refreshing…' : 'Refresh all'}
              </button>
            </div>
          </div>
          {open && tab === 'environments' && <EnvironmentSettings missing={missing} />}
          {open && tab === 'sidebar' && <SidebarSettings />}
          {open && tab === 'archived' && <ArchivedSettings />}
          {open && tab === 'storage' && <StorageSettings />}
        </div>
      </div>
    </Dialog>
  );
}
function EnvironmentSettings({ missing }: { missing: Check[] }) {
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
        {
          environment,
          ...(editing ? { expectedRevision: editing.revision } : {}),
        },
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
    <div id="environments-settings" className="settings-panel" role="tabpanel" aria-labelledby="environments-tab">
      <div className="dialog-body">
        <div className="settings-page-heading">
          <div>
            <h2>Environments</h2>
            <p>Choose where checks run and which test accounts they use.</p>
          </div>
          <button
            type="button"
            id="new-environment"
            className="settings-button"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setVersion((v) => v + 1);
              setMessage('');
            }}
          >
            <Icon name="plus" />
            Add environment
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
        {!!missing.length && (
          <details id="doctor" className="settings-disclosure workspace-checks">
            <summary>
              <span>
                <strong>Workspace checks</strong>
                <small>
                  {missing.length} {missing.length === 1 ? 'item needs' : 'items need'} attention in the selected run environment.
                </small>
              </span>
              <Icon name="chevron" />
            </summary>
            <ul className="settings-disclosure-body">
              {missing.map((check) => (
                <li key={check.name}>
                  <strong>{check.name}</strong>
                  <p>{check.detail}</p>
                  {check.fix && <code>{check.fix}</code>}
                </li>
              ))}
            </ul>
          </details>
        )}
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
    (environment?.users ?? [{ id: '', name: '' }]).map((user) => ({
      key: crypto.randomUUID(),
      user,
    })),
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
            Environment ID
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
            Run against
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
            + Add test user
          </button>
        </div>
        <p className="environment-help">
          Link saved credentials using a 1Password reference or an environment variable. Enter references, not passwords.
        </p>
        <details className="environment-reference-help">
          <summary>How to reference credentials</summary>
          <p className="environment-help">
            For 1Password, use <code>op://vault/item/password</code>. For a variable available to the checker, use{' '}
            <code>env://STAGING_PASSWORD</code>. The checker reads the value when a run needs it.
          </p>
        </details>
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
