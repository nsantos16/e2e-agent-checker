import { defaultInstanceId, providerInstanceId, targetInstanceId } from '../../../providers/schema.ts';
import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { providerMark, providerMessage } from '../format.ts';
import { Dialog } from './Dialog.tsx';
import { Icon } from './Icon.tsx';
import { SelectPicker, usePickerPosition } from './Picker.tsx';
export function ModelPicker({ open }: { open: boolean }) {
  const { state: s, actions: store } = useWorkspace();
  const [providerId, setProviderId] = useState(
    s.targets[0] ? targetInstanceId(s.targets[0]) : (s.providers.find((p) => p.ready)?.instanceId ?? defaultInstanceId('codex')),
  );
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const position = usePickerPosition(open, undefined, true);
  useEffect(() => {
    if (open && s.targets[0]) setProviderId(targetInstanceId(s.targets[0]));
  }, [open]);
  const p = s.providers.find((p) => providerInstanceId(p) === providerId),
    q = query.toLowerCase();
  const models = p?.models.filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) ?? [];
  const close = () => store.patch({ dialog: null });
  return (
    <Dialog open={open} id="model-dialog" className="picker-dialog model-dialog" title="Choose models" onClose={close} style={position}>
      <div className="picker-search">
        <Icon name="search" />
        <input
          ref={search}
          autoFocus
          id="model-search"
          placeholder="Search models…"
          aria-label="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="icon-btn" data-close="model-dialog" aria-label="Close model picker" onClick={close}>
          ×
        </button>
      </div>
      <div className="model-picker-body">
        <div id="provider-rail" className="provider-rail" aria-label="Providers">
          {s.providers.map((p) => (
            <button
              key={providerInstanceId(p)}
              data-picker-provider={p.id}
              data-picker-instance={providerInstanceId(p)}
              aria-pressed={providerInstanceId(p) === providerId}
              title={`${p.name}${p.ready ? '' : ' · unavailable'}`}
              aria-label={p.name}
              onClick={() => {
                setProviderId(providerInstanceId(p));
                setQuery('');
                search.current?.focus();
              }}
            >
              {providerMark[p.id]} <small>{p.name}</small>
            </button>
          ))}
        </div>
        <div className="model-list" id="model-list">
          {!p ? (
            <div className="empty">Checking connections…</div>
          ) : (
            <>
              <div className="model-group-label">
                {p.name}
                {p.ready ? ' · subscription' : ''}
                {p.account?.email && <small> · {p.account.email}</small>}
              </div>
              {p.ready ? (
                models.length ? (
                  models.map((m) => {
                    const selected = s.targets.some((t) => targetInstanceId(t) === providerInstanceId(p) && t.model === m.id);
                    return (
                      <div key={m.id}>
                        <label className="model-option">
                          <input
                            type="checkbox"
                            data-model={m.id}
                            data-provider={p.id}
                            checked={selected}
                            onChange={() =>
                              store.toggleTarget({
                                provider: p.id,
                                instanceId: providerInstanceId(p),
                                instanceRevision: p.revision,
                                accountFingerprint: p.accountFingerprint,
                                resolvedModel: m.resolvedModel,
                                model: m.id,
                                authMode: 'subscription',
                              })
                            }
                          />
                          <span>{m.name}</span>
                          {selected && <small>Selected</small>}
                        </label>
                        {selected && !!m.efforts?.length && (
                          <label className="model-effort">
                            Effort
                            <SelectPicker
                              label={`${m.name} effort`}
                              value={
                                s.targets.find((t) => targetInstanceId(t) === providerInstanceId(p) && t.model === m.id)?.options?.effort ??
                                ''
                              }
                              onChange={(value) =>
                                store.setTargetOptions(
                                  { provider: p.id, instanceId: providerInstanceId(p), model: m.id, authMode: 'subscription' },
                                  value,
                                )
                              }
                              options={[
                                { value: '', label: 'Native default' },
                                ...m.efforts.map((effort) => ({ value: effort, label: effort })),
                              ]}
                            />
                          </label>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="empty">No matching models</div>
                )
              ) : (
                <div className="model-unavailable">
                  {providerMessage(p)}
                  <br />
                  <button id="picker-setup" onClick={() => store.patch({ dialog: 'settings' })}>
                    Manage connection
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="picker-footer">
        <span id="model-selection-count">
          {s.targets.length
            ? `${s.targets.length} model${s.targets.length === 1 ? '' : 's'} selected · one run per model`
            : 'Select models to compare'}
        </span>
        <button data-close="model-dialog" onClick={close}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
