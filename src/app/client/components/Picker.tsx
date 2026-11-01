import { useEffect, useLayoutEffect, useRef, useState, useId, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from './Dialog.tsx';
import { Icon } from './Icon.tsx';

// Keep menus in the viewport and clear of the composer, including when controls wrap.
export function usePickerPosition(open: boolean, anchor?: RefObject<HTMLButtonElement | null>, composer = false) {
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const element = composer ? document.querySelector('.composer') : anchor?.current;
    if (!element) return;
    const viewport = window.visualViewport;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = Math.min(480, (viewport?.width ?? window.innerWidth) - 24);
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const above = rect.top - top - 20;
      const below = bottom - rect.bottom - 20;
      const placeAbove = composer || (below < 280 && above > below);
      setPosition({
        width,
        left: Math.max(left + 12, Math.min(rect.left, left + (viewport?.width ?? window.innerWidth) - width - 12)),
        ...(placeAbove
          ? { top: 'auto', bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(0, above) }
          : { top: rect.bottom + 8, bottom: 'auto', maxHeight: Math.max(0, below) }),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
    };
  }, [open, anchor, composer]);
  return position;
}

export type PickerOption = { value: string; label: string; description?: string; disabled?: boolean };

export function SelectPicker({
  id,
  label,
  value,
  options,
  onChange,
  placeholder = 'Select an option',
  disabled,
  className = '',
  icon,
  title,
  composer = false,
  ...attributes
}: {
  id?: string;
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  icon?: string;
  title?: string;
  composer?: boolean;
}) {
  const uid = useId();
  const triggerId = id ?? `picker-${uid}`;
  const dialogId = `${triggerId}-picker`;
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string>();
  const selected = options.find((option) => option.value === value);
  const matches = options.filter((option) => `${option.label} ${option.description ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const enabled = matches.filter((option) => !option.disabled);
  const current = enabled.find((option) => option.value === active) ?? enabled.find((option) => option.value === value) ?? enabled[0];
  const optionId = (option: PickerOption) => `${dialogId}-option-${options.indexOf(option)}`;
  const position = usePickerPosition(open, trigger, composer);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  };
  const choose = (option: PickerOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
  };
  useEffect(() => {
    if (!open || !current) return;
    const frame = requestAnimationFrame(() => document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [open, current?.value]);
  return (
    <>
      <button
        {...attributes}
        ref={trigger}
        id={triggerId}
        type="button"
        className={`select-trigger ${className}`}
        value={value}
        disabled={disabled}
        title={title ?? selected?.label ?? placeholder}
        aria-label={`${label}: ${selected?.label ?? placeholder}`}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-expanded={open}
        onClick={() => {
          setQuery('');
          setActive(value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setQuery('');
            setActive(value);
            setOpen(true);
          }
        }}
      >
        {icon && <Icon name={icon} />}
        <span className="select-value">{selected?.label ?? placeholder}</span>
        <Icon name="chevron" className="chevron" />
      </button>
      {open &&
        createPortal(
          <Dialog open={open} id={dialogId} className="picker-dialog select-dialog" title={label} onClose={close} style={position}>
            <div className="picker-search">
              <Icon name="search" />
              <input
                autoFocus
                role="combobox"
                aria-label={`Search ${label.toLowerCase()}`}
                aria-autocomplete="list"
                aria-controls={`${dialogId}-list`}
                aria-expanded="true"
                aria-activedescendant={current ? optionId(current) : undefined}
                placeholder={`Search ${label.toLowerCase()}…`}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const index = current ? enabled.indexOf(current) : -1;
                    setActive(enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]?.value);
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (current) choose(current);
                  }
                }}
              />
              <button type="button" className="icon-btn" aria-label={`Close ${label.toLowerCase()} picker`} onClick={close}>
                ×
              </button>
            </div>
            <div className="picker-list" id={`${dialogId}-list`} role="listbox" aria-label={label}>
              <div className="picker-group-label" role="presentation">
                {label}
              </div>
              {matches.map((option) => (
                <button
                  type="button"
                  id={optionId(option)}
                  key={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  tabIndex={-1}
                  data-value={option.value}
                  data-active={option === current}
                  className="picker-option"
                  onClick={() => choose(option)}
                >
                  <span className="picker-check" aria-hidden="true">
                    {option.value === value ? '✓' : ''}
                  </span>
                  <span className="picker-option-copy">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              ))}
              {!matches.length && (
                <div className="empty" role="status">
                  {options.length ? 'No matching options' : 'No options available'}
                </div>
              )}
            </div>
            <div className="picker-footer">
              <span>{selected?.label ?? placeholder}</span>
              <button type="button" onClick={close}>
                Done
              </button>
            </div>
          </Dialog>,
          document.body,
        )}
    </>
  );
}
