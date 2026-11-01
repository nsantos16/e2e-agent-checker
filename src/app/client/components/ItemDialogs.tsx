import { useEffect, useState } from 'react';
import { useWorkspace } from '../context.tsx';
import { errorMessage } from '../api.ts';
import { Dialog, DialogHeader } from './Dialog.tsx';

export function ItemDialogs() {
  const { state: s, actions: store } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const close = () => {
    if (!busy) store.patch({ confirmDelete: null });
  };
  useEffect(() => {
    setError('');
  }, [s.confirmDelete]);
  useEffect(() => {
    if (!s.undoArchive) return;
    const notice = s.undoArchive;
    const timer = setTimeout(() => {
      store.patch({ undoArchive: null });
    }, 5000);
    const undo = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        void store.restoreItem(notice.item, notice.reopen).catch(store.report);
      }
    };
    document.addEventListener('keydown', undo);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', undo);
    };
  }, [store, s.undoArchive]);
  return (
    <>
      {s.undoArchive && (
        <div className="undo-notice" role="status">
          <span>Archived {s.undoArchive.item.value.title ?? 'run'}.</span>
          <button onClick={() => void store.restoreItem(s.undoArchive!.item, s.undoArchive!.reopen).catch(store.report)}>Undo</button>
        </div>
      )}
      <Dialog id="delete-item-dialog" className="import-dialog" title="Delete item" open={!!s.confirmDelete} onClose={close}>
        <DialogHeader id="delete-item-dialog" onClose={close}>
          Delete {s.confirmDelete?.kind ?? 'item'}?
        </DialogHeader>
        <div className="dialog-body">
          <p>
            <strong>{s.confirmDelete?.value.title ?? 'This run'}</strong>
          </p>
          <p>
            This permanently removes the {s.confirmDelete?.kind} from this workspace. It cannot be restored. Saved run files are kept until
            your storage cleanup rules remove them.
          </p>
          {s.confirmDelete?.kind === 'case' && <p>Existing runs keep their original case snapshots and continue working.</p>}
          <p role="alert">{error}</p>
        </div>
        <div className="dialog-actions">
          <button disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (!s.confirmDelete) return;
              setBusy(true);
              void store
                .deleteItem(s.confirmDelete)
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </Dialog>
    </>
  );
}
