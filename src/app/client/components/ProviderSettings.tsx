import { SelectPicker } from './Picker.tsx';
import { useState, type ReactNode } from 'react';
import {
  defaultInstanceId,
  providerInstanceId,
  targetInstanceId,
  type InstanceConfig,
  type Provider,
  type ProviderInstance,
} from '../../../providers/schema.ts';
import { useWorkspace } from '../context.tsx';
import { errorMessage } from '../api.ts';
import { providerMark, providerMessage } from '../format.ts';
import { Icon } from './Icon.tsx';

const kinds = {
  'claude-code': {
    name: 'Claude Code',
    binary: 'claude',
    profile: 'CLAUDE_CONFIG_DIR',
    directory: '~/.claude-work',
  },
  codex: {
    name: 'Codex',
    binary: 'codex',
    profile: 'CODEX_HOME',
    directory: '~/.codex-work',
  },
  cursor: { name: 'Cursor', binary: 'agent', profile: '', directory: '' },
};
const withoutRevision = ({ revision, ...i }: ProviderInstance): InstanceConfig => i;
const titleCase = (text: string) => text.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function status(p: Provider) {
  if (p.config?.enabled === false) return { label: 'Disabled', tone: 'muted' };
  if (p.limits?.some((l) => l.exhausted) || p.reason?.startsWith('USAGE_EXHAUSTED'))
    return { label: 'Usage limit reached', tone: 'warning' };
  if (p.ready) return { label: 'Ready', tone: 'ready' };
  if (p.reason?.startsWith('AUTH_EXPIRED')) return { label: 'Sign-in expired', tone: 'warning' };
  if (p.reason?.startsWith('INSTALLATION_MISSING')) return { label: 'Not installed', tone: 'warning' };
  if (!p.installed) return { label: 'Setup needed', tone: 'warning' };
  if (p.auth === 'api-key') return { label: 'API billing detected', tone: 'warning' };
  if (p.auth === 'logged-out') return { label: 'Sign-in needed', tone: 'warning' };
  if (p.auth === 'subscription' && p.reason?.startsWith('CAPABILITY_UNSUPPORTED')) return { label: 'Runs unavailable', tone: 'muted' };
  return { label: 'Needs attention', tone: 'warning' };
}
function AccountStatus({ provider }: { provider: Provider }) {
  const value = status(provider);
  return (
    <span className={`account-status ${value.tone}`}>
      <span aria-hidden="true" />
      {value.label}
    </span>
  );
}
function SettingRow({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="provider-row">
      <div className="provider-row-label">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="provider-row-control">{children}</div>}
    </div>
  );
}
function Disclosure({ title, hint, children, className = '' }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <details className={`settings-disclosure ${className}`}>
      <summary>
        <span>
          <strong>{title}</strong>
          {hint && <small>{hint}</small>}
        </span>
        <Icon name="chevron" />
      </summary>
      <div className="settings-disclosure-body">{children}</div>
    </details>
  );
}

export function ProviderSettings() {
  const { state: s, actions: store } = useWorkspace();
  const [selectedId, setSelectedId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [login, setLogin] = useState<{ id: string; command: string }>();
  const [busy, setBusy] = useState(false);
  const selected = s.providers.find((p) => providerInstanceId(p) === selectedId) ?? s.providers.find((p) => p.selected) ?? s.providers[0];
  const operation = async (work: () => Promise<unknown>, success = '') => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await work();
      await store.refreshProviders(false);
      setMessage(success);
    } catch (e) {
      setFailed(true);
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const action = (p: Provider) => ({
    instanceId: providerInstanceId(p),
    expectedRevision: p.revision,
  });
  const refresh = (p: Provider) =>
    operation(() => store.api(`/api/providers?fresh=1&instanceId=${encodeURIComponent(providerInstanceId(p))}`), 'Connection refreshed.');
  return (
    <div id="providers">
      <div className="settings-page-heading">
        <div>
          <h2>Providers</h2>
          <p>Connect your subscriptions and choose an account for your runs.</p>
        </div>
        <button
          className="settings-button"
          disabled={busy || adding}
          onClick={() => {
            setAdding(true);
            setMessage('');
          }}
        >
          <Icon name="plus" />
          Add account
        </button>
      </div>
      <div className="provider-workspace">
        <aside className="provider-account-list" aria-label="Provider accounts">
          <div className="settings-eyebrow">
            Your accounts <span>{s.providers.length}</span>
          </div>
          <div className="provider-account-buttons">
            {s.providers.map((p) => {
              const id = providerInstanceId(p);
              const inComposer = s.targets.some((t) => targetInstanceId(t) === id);
              return (
                <button
                  key={id}
                  className="provider-account-button"
                  data-manage-provider={id}
                  aria-label={`Manage ${p.name}`}
                  aria-pressed={!adding && providerInstanceId(selected) === id}
                  disabled={busy}
                  onClick={() => {
                    setSelectedId(id);
                    setAdding(false);
                    setMessage('');
                  }}
                >
                  <span className={`provider-avatar ${p.id}`} aria-hidden="true">
                    {providerMark[p.id]}
                  </span>
                  <span className="provider-account-label">
                    <strong title={p.name}>{p.name}</strong>
                    <small title={p.account?.email}>{p.account?.email ?? kinds[p.id].name}</small>
                    <AccountStatus provider={p} />
                  </span>
                  {inComposer && (
                    <span className="account-in-composer" title="Selected in the run composer" aria-label="In composer">
                      <Icon name="check" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="provider-list-note">
            <Icon name="shield" />
            <span>Text runs use your native subscription. No API key needed.</span>
          </p>
        </aside>
        <div className="provider-editor">
          {adding ? (
            <section className="provider-detail">
              <div className="provider-detail-heading">
                <div>
                  <h3>Add account</h3>
                  <p>Create a separate profile, then sign in with its subscription.</p>
                </div>
              </div>
              <InstanceForm
                key="new"
                instance={null}
                busy={busy}
                close={() => {
                  setAdding(false);
                  setMessage('');
                }}
                save={(instance) =>
                  operation(async () => {
                    await store.api('/api/provider-instances', { instance });
                    setSelectedId(instance.id);
                    setAdding(false);
                    setLogin(undefined);
                  }, 'Account added. Sign in to load its models.')
                }
              />
            </section>
          ) : selected ? (
            <section key={providerInstanceId(selected)} className="provider-detail" data-provider-instance={providerInstanceId(selected)}>
              <div className="provider-detail-heading">
                <div>
                  <h3>{selected.name}</h3>
                  <p>
                    {kinds[selected.id].name} · {selected.config?.configDir ? 'Separate profile' : 'Default profile'}
                  </p>
                </div>
                <AccountStatus provider={selected} />
              </div>
              {(!selected.ready || selected.limits?.some((l) => l.exhausted)) && (
                <div className={`provider-notice ${status(selected).tone}`}>
                  <p>
                    {selected.limits?.some((l) => l.exhausted)
                      ? 'This account has reached a usage limit. Open Usage limits for the details reported by the provider.'
                      : providerMessage(selected)}
                  </p>
                </div>
              )}
              <div className="settings-card">
                <SettingRow
                  title="Account"
                  description={
                    <>
                      <span className="provider-account-email">
                        {selected.account?.email ??
                          (selected.config?.enabled === false
                            ? 'Not checked while disabled'
                            : selected.auth === 'subscription'
                              ? 'Signed in'
                              : selected.auth === 'api-key'
                                ? 'API key active'
                                : selected.auth === 'logged-out'
                                  ? 'Not signed in'
                                  : 'Sign-in not verified')}
                      </span>
                      {selected.auth === 'subscription' && (
                        <span className="provider-plan">
                          {selected.account?.plan ? `${titleCase(selected.account.plan)} subscription` : 'Subscription'}
                        </span>
                      )}
                    </>
                  }
                >
                  <button
                    className="settings-button"
                    disabled={busy || selected.config?.enabled === false}
                    aria-expanded={login?.id === providerInstanceId(selected)}
                    onClick={() => {
                      if (login?.id === providerInstanceId(selected)) {
                        setLogin(undefined);
                        return;
                      }
                      void operation(async () => {
                        const result = await store.api<{
                          loginCommand: string;
                        }>('/api/provider-instances/auth', action(selected));
                        setLogin({
                          id: providerInstanceId(selected),
                          command: result.loginCommand,
                        });
                      });
                    }}
                  >
                    {selected.auth === 'subscription' ? 'Reconnect' : 'Sign in'}
                  </button>
                </SettingRow>
                {login?.id === providerInstanceId(selected) && (
                  <LoginInstructions
                    key={login.command}
                    command={login.command}
                    provider={kinds[selected.id].name}
                    busy={busy}
                    refresh={() => void refresh(selected)}
                  />
                )}
                <SettingRow
                  title="Models"
                  description={
                    selected.models.length
                      ? `${selected.models.length} ${selected.models.length === 1 ? 'model' : 'models'} available for this account.`
                      : 'Check the connection to load available models.'
                  }
                >
                  <button
                    className="primary settings-button"
                    disabled={busy || !selected.ready}
                    onClick={() => void operation(() => store.chooseProvider(selected))}
                  >
                    Use account
                  </button>
                </SettingRow>
                {selected.config && (
                  <SettingRow title="Enabled" description="Available for new runs in the model picker.">
                    <button
                      className="settings-switch"
                      role="switch"
                      aria-label={`Enable ${selected.name}`}
                      aria-checked={selected.config.enabled}
                      disabled={busy}
                      onClick={() =>
                        void operation(async () => {
                          await store.api('/api/provider-instances', {
                            instance: {
                              ...withoutRevision(selected.config!),
                              enabled: !selected.config!.enabled,
                            },
                            expectedRevision: selected.revision,
                          });
                          setLogin(undefined);
                        })
                      }
                    >
                      <span />
                    </button>
                  </SettingRow>
                )}
              </div>
              {!!selected.models.length && (
                <Disclosure title="Available models" hint="Models and effort options reported by this account.">
                  <ul className="provider-model-list">
                    {selected.models.map((m) => (
                      <li key={m.id}>
                        <strong>{m.name}</strong>
                        {m.name !== m.id && <code>{m.id}</code>}
                        {!!m.efforts?.length && <small>Effort: {m.efforts.join(', ')}</small>}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
              {!!selected.limits?.length && (
                <Disclosure title="Usage limits" hint="Reported by the provider.">
                  {selected.limits.map((limit) => (
                    <div className="provider-limit" key={limit.name}>
                      <div>
                        <strong>{titleCase(limit.name)}</strong>
                        <span>
                          {limit.exhausted
                            ? 'Limit reached'
                            : limit.usedPercent !== undefined
                              ? `${Math.round(limit.usedPercent)}% used`
                              : 'Usage unavailable'}
                        </span>
                      </div>
                      {limit.usedPercent !== undefined && (
                        <meter min={0} max={100} value={limit.usedPercent} aria-label={`${limit.name} usage`} />
                      )}
                      {limit.resetsAt && <small>Resets {new Date(limit.resetsAt * 1000).toLocaleString()}</small>}
                    </div>
                  ))}
                </Disclosure>
              )}
              {selected.config && (
                <Disclosure title="Configuration" hint="Account name, profile directory, and executable.">
                  <InstanceForm
                    key={selected.revision}
                    instance={selected.config}
                    busy={busy}
                    save={(instance) =>
                      operation(async () => {
                        await store.api('/api/provider-instances', {
                          instance,
                          expectedRevision: selected.revision,
                        });
                        setLogin(undefined);
                      }, 'Account settings saved.')
                    }
                    remove={
                      selected.config.id !== defaultInstanceId(selected.id)
                        ? () =>
                            operation(async () => {
                              await store.api('/api/provider-instances/delete', action(selected));
                              setLogin(undefined);
                            }, 'Account removed from the checker. Native sign-in and past runs are kept.')
                        : undefined
                    }
                  />
                </Disclosure>
              )}
              <Disclosure title="Connection details" hint="Installation, last check, and troubleshooting.">
                <dl className="provider-diagnostics">
                  <dt>Installation</dt>
                  <dd>
                    {selected.config?.enabled === false
                      ? 'Not checked while disabled'
                      : selected.installed
                        ? `${kinds[selected.id].name}${selected.version ? ` ${selected.version}` : ' installed'}`
                        : 'Not detected. Check the executable in Configuration.'}
                  </dd>
                  <dt>Sign-in type</dt>
                  <dd>
                    {selected.auth === 'subscription'
                      ? 'Native subscription'
                      : selected.auth === 'api-key'
                        ? 'API key · reconnect with a subscription'
                        : selected.auth === 'logged-out'
                          ? 'Signed out'
                          : 'Not verified'}
                  </dd>
                  <dt>Last checked</dt>
                  <dd>{selected.checkedAt ? new Date(selected.checkedAt).toLocaleString() : 'Not checked yet'}</dd>
                  <dt>Account ID</dt>
                  <dd>
                    <code>{providerInstanceId(selected)}</code>
                  </dd>
                  {selected.account?.organization && (
                    <>
                      <dt>Organization</dt>
                      <dd>{selected.account.organization}</dd>
                    </>
                  )}
                </dl>
                {!!selected.ignoredEnvironment?.length && (
                  <div className="provider-environment-note">
                    <strong>API overrides ignored</strong>
                    <p>These settings are excluded from subscription runs. Your machine’s settings are unchanged.</p>
                    <code>{selected.ignoredEnvironment.join(', ')}</code>
                  </div>
                )}
              </Disclosure>
              <div className="provider-detail-footer">
                <span>
                  {selected.checkedAt
                    ? `Checked ${new Date(selected.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                    : 'Not checked yet'}
                </span>
                <button className="settings-button" disabled={busy || s.refreshingProviders} onClick={() => void refresh(selected)}>
                  <Icon name="replay" />
                  Refresh connection
                </button>
              </div>
            </section>
          ) : (
            <p className="settings-empty">Loading provider accounts…</p>
          )}
          {!!message && (
            <p className={`settings-message ${failed ? 'error' : ''}`} role={failed ? 'alert' : 'status'}>
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
function LoginInstructions({
  command,
  provider,
  busy,
  refresh,
}: {
  command: string;
  provider: string;
  busy: boolean;
  refresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="provider-login">
      <ol>
        <li>
          <strong>Sign in on this machine</strong>
          <p>Run the command in your terminal and complete {provider}’s sign-in.</p>
          <button
            className="settings-button"
            onClick={() =>
              void navigator.clipboard
                .writeText(command)
                .then(() => {
                  setCopied(true);
                  setError('');
                })
                .catch(() => setError('Copy failed. Expand the command and copy it manually.'))
            }
          >
            <Icon name="copy" />
            {copied ? 'Copied' : 'Copy sign-in command'}
          </button>
          <details className="provider-command">
            <summary>Show command</summary>
            <code>{command}</code>
          </details>
        </li>
        <li>
          <strong>Check the connection</strong>
          <p>Return here to load the account and its available models.</p>
          <button className="settings-button" disabled={busy} onClick={refresh}>
            Check connection
          </button>
        </li>
      </ol>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function InstanceForm({
  instance,
  busy,
  close,
  save,
  remove,
}: {
  instance: ProviderInstance | null;
  busy: boolean;
  close?: () => void;
  save: (i: InstanceConfig) => Promise<void>;
  remove?: () => Promise<void>;
}) {
  const [kind, setKind] = useState<InstanceConfig['provider']>(instance?.provider ?? 'claude-code');
  const [binary, setBinary] = useState(instance?.binaryPath ?? 'claude');
  const [name, setName] = useState(instance?.name ?? '');
  const [suffix] = useState(() => crypto.randomUUID().slice(0, 8));
  const [customId, setCustomId] = useState('');
  const generatedId = `${kind}-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'account'
  }-${suffix}`;
  return (
    <form
      className="provider-instance-form"
      autoComplete="off"
      onInvalidCapture={(event) => {
        if (event.target instanceof HTMLInputElement) {
          const section = event.target.closest('details');
          if (section) section.open = true;
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget),
          read = (key: string) => String(data.get(key) ?? '').trim();
        void save({
          id: instance?.id ?? (customId.trim() || generatedId),
          provider: kind,
          name: name.trim(),
          enabled: instance?.enabled ?? true,
          binaryPath: binary.trim(),
          ...(read('configDir') ? { configDir: read('configDir') } : {}),
          options: instance?.options ?? {},
        });
      }}
    >
      <fieldset disabled={busy}>
        {!instance && (
          <label>
            Provider
            <SelectPicker
              label="Provider"
              value={kind}
              onChange={(value) => {
                const k = value as typeof kind;
                setKind(k);
                setBinary(kinds[k].binary);
              }}
              options={[
                { value: 'claude-code', label: 'Claude Code' },
                { value: 'codex', label: 'Codex / ChatGPT' },
                { value: 'cursor', label: 'Cursor', description: 'Separate accounts unavailable', disabled: true },
              ]}
            />
          </label>
        )}
        <label>
          Account name
          <input
            name="name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Work account"
            autoFocus={!instance}
          />
          <small>Shown in Settings and the model picker.</small>
        </label>
        {!!kinds[kind].profile && (
          <label>
            Profile directory
            <input
              name="configDir"
              required={!instance}
              defaultValue={instance?.configDir}
              placeholder={instance ? 'Default native profile' : kinds[kind].directory}
              spellCheck={false}
            />
            <small>
              {instance
                ? 'Leave blank to use the app’s default sign-in. Use a separate folder for another account.'
                : 'Use a separate folder for this account. Sign in after adding it.'}
            </small>
          </label>
        )}
        {instance?.provider === 'cursor' && (
          <p className="environment-help">Cursor uses its default native profile. Separate accounts are not supported yet.</p>
        )}
        <details className="provider-advanced">
          <summary>Advanced settings</summary>
          <label>
            Executable
            <input name="binaryPath" required value={binary} onChange={(e) => setBinary(e.target.value)} spellCheck={false} />
            <small>The command name or full path to {kinds[kind].name}.</small>
          </label>
          <label>
            Account ID
            <input
              name="id"
              pattern="[a-z0-9][a-z0-9_-]{0,63}"
              readOnly={!!instance}
              value={instance?.id ?? customId}
              onChange={(e) => setCustomId(e.target.value)}
              placeholder={generatedId}
              spellCheck={false}
            />
            <small>
              {instance ? 'Permanent identifier for saved runs and MCP.' : 'Created automatically. Set your own only if needed for MCP.'}
            </small>
          </label>
          {!!kinds[kind].profile && (
            <p className="environment-help">
              The profile directory sets <code>{kinds[kind].profile}</code>. Sign-in stays with {kinds[kind].name}.
            </p>
          )}
        </details>
        <div className="provider-form-actions">
          {remove && (
            <button className="settings-button danger" type="button" onClick={() => void remove()}>
              Remove account
            </button>
          )}
          {close && (
            <button className="settings-button" type="button" onClick={close}>
              Cancel
            </button>
          )}
          <button className="primary settings-button" type="submit">
            {instance ? 'Save changes' : 'Add account'}
          </button>
        </div>
        {remove && <p className="environment-help">Removing an account only removes its checker configuration.</p>}
      </fieldset>
    </form>
  );
}
