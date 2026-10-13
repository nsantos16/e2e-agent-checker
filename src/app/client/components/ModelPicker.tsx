import { useRef, useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { providerMark, providerMessage } from '../format.ts';
import { Dialog } from './Dialog.tsx';
import { Icon } from './Icon.tsx';
export function ModelPicker({ open }: { open: boolean }) {
  const { state: s, actions: store } = useWorkspace();
  const [providerId, setProviderId] = useState(s.targets[0]?.provider ?? s.providers.find((p) => p.ready)?.id ?? 'codex');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const p = s.providers.find((p) => p.id === providerId),
    q = query.toLowerCase();
  const models = p?.models.filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) ?? [];
  const close = () => store.patch({ dialog: null });
  return (
    <Dialog open={open} id="model-dialog" className="model-dialog" title="Choose models" onClose={close}>
      <div className="model-search">
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
              key={p.id}
              data-picker-provider={p.id}
              aria-pressed={p.id === providerId}
              title={`${p.name}${p.ready ? '' : ' · unavailable'}`}
              aria-label={p.name}
              onClick={() => {
                setProviderId(p.id);
                setQuery('');
                search.current?.focus();
              }}
            >
              {providerMark[p.id]}
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
              </div>
              {p.ready ? (
                models.length ? (
                  models.map((m) => {
                    const selected = s.targets.some((t) => t.provider === p.id && t.model === m.id);
                    return (
                      <label className="model-option" key={m.id}>
                        <input
                          type="checkbox"
                          data-model={m.id}
                          data-provider={p.id}
                          checked={selected}
                          onChange={() => store.toggleTarget({ provider: p.id, model: m.id, authMode: 'subscription' })}
                        />
                        <span>{m.name}</span>
                        {selected && <small>Selected</small>}
                      </label>
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
      <div className="model-footer">
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
