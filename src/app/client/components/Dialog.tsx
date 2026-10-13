import { useEffect, useRef, type ReactNode } from 'react';
export function Dialog({
  id,
  className,
  title,
  open,
  onClose,
  children,
}: {
  id: string;
  className: string;
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      id={id}
      className={className}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
export function DialogHeader({ id, children, onClose }: { id: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="dialog-head">
      <h2 id={`${id}-title`}>{children}</h2>
      <button
        className="icon-btn"
        data-close={id}
        aria-label={`Close ${typeof children === 'string' ? children.toLowerCase() : 'dialog'}`}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
