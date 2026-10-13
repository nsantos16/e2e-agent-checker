import { useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { errorMessage } from '../api.ts';
import { Dialog, DialogHeader } from './Dialog.tsx';
export function RunOptions({ open }: { open: boolean }) {
  const { state: s, actions: store } = useWorkspace();
  const close = () => store.patch({ dialog: null });
  return (
    <Dialog open={open} id="options-dialog" className="settings-dialog" title="Run options" onClose={close}>
      <DialogHeader id="options-dialog" onClose={close}>
        Run options
      </DialogHeader>
      <div className="dialog-body">
        <div className="field">
          <label htmlFor="role">
            Test user<small>Users belong to the selected environment. Shared accounts run in sequence.</small>
          </label>
          <select id="role" value={s.userId} onChange={(e) => store.chooseUser(e.target.value)}>
            {store.environment()?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="timeout">
            Time limit<small>Minutes per run, including setup.</small>
          </label>
          <input
            id="timeout"
            type="number"
            value={Number.isNaN(s.timeout) ? '' : s.timeout}
            min="1"
            max="60"
            onChange={(e) => store.patch({ timeout: e.target.valueAsNumber })}
          />
        </div>
        <div className="field">
          <label htmlFor="attempts">
            Test attempts<small>Maximum attempts to stabilize the spec.</small>
          </label>
          <input
            id="attempts"
            type="number"
            value={Number.isNaN(s.attempts) ? '' : s.attempts}
            min="1"
            max="8"
            onChange={(e) => store.patch({ attempts: e.target.valueAsNumber })}
          />
        </div>
      </div>
      <div className="dialog-actions">
        <span>Applied to each case × model combination.</span>
        <button data-close="options-dialog" onClick={close}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
export function ImportCase({ open }: { open: boolean }) {
  const { actions: store } = useWorkspace();
  const [id, setId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const close = () => store.patch({ dialog: null });
  const submit = async () => {
    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      setError('Enter a case ID.');
      return;
    }
    setBusy(true);
    try {
      await store.api('/api/cases', { project: 'DEMO', id: Number(id) });
      await store.refreshCases();
      close();
      store.showTab('cases');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} id="import-dialog" className="import-dialog" title="Import a Qase case" onClose={close}>
      <DialogHeader id="import-dialog" onClose={close}>
        Import a Qase case
      </DialogHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-body">
          <p>Add a case from your Qase project to this workspace.</p>
          <label htmlFor="add-id" className="muted">
            Case ID
          </label>
          <input
            autoFocus
            id="add-id"
            type="number"
            placeholder="e.g. 6003"
            style={{ display: 'block', width: '100%', marginTop: 8 }}
            min="1"
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </div>
        <div className="dialog-actions">
          <span id="import-error" role="alert">
            {error}
          </span>
          <button id="add" disabled={busy}>
            Import case
          </button>
        </div>
      </form>
    </Dialog>
  );
}
