import { useRef, useState, type ReactNode } from 'react';
import { useWorkspace } from '../context.tsx';
import { terminal } from '../format.ts';
import { sidebarGroups, sidebarItemKey, moveSidebarItem, type SidebarGroup } from '../sidebar.ts';
import type { SidebarItem } from '../types.ts';
import { Icon } from './Icon.tsx';

export function SidebarGroups({ items, render }: { items: SidebarItem[]; render: (item: SidebarItem) => ReactNode }) {
  const { state: s, actions: store } = useWorkspace();
  const dragged = useRef<{ item: SidebarItem; group: string; index: number } | null>(null);
  const renderGroup = (group: SidebarGroup): ReactNode => {
    const collapsed = s.collapsedGroups.has(group.key) && !s.search;
    return (
      <section key={group.key} className="sidebar-group" aria-label={group.label || 'Items'}>
        {group.label && (
          <button
            className="group-header"
            aria-expanded={!collapsed}
            onClick={() => store.toggleGroup(group.key)}
            onDragOver={(e) => {
              if (['Pinned', 'Settled', 'Active'].includes(group.label)) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const source = dragged.current;
              if (!source || !['Pinned', 'Settled', 'Active'].includes(group.label)) return;
              void store
                .organize(source.item, { pinned: group.label === 'Pinned', settled: group.label === 'Settled' })
                .catch(store.report);
              dragged.current = null;
            }}
          >
            <Icon name="chevron" className={collapsed ? 'collapsed' : ''} />
            <span>{group.label}</span>
            <small>{group.items.length}</small>
            {group.items.some((item) => item.kind === 'run' && !terminal(item.value)) && (
              <span className="status-dot running" title="Work in progress" />
            )}
          </button>
        )}
        <div hidden={!!collapsed} className={group.children ? 'sidebar-subgroups' : undefined}>
          {group.children
            ? group.children.map(renderGroup)
            : group.items.map((item, index) => (
                <div
                  key={sidebarItemKey(item)}
                  className="sidebar-entry"
                  draggable={!s.search}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.currentTarget.querySelector<HTMLButtonElement>('.item-actions > button')?.click();
                  }}
                  onDragStart={(event) => {
                    dragged.current = { item, group: group.key, index };
                    event.dataTransfer.setData('text/plain', sidebarItemKey(item));
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                  }}
                  onDragOver={(event) => {
                    if (dragged.current?.group === group.key) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const source = dragged.current;
                    if (source?.group === group.key)
                      void store.reorderItems(moveSidebarItem(group.items, source.index, index)).catch(store.report);
                    dragged.current = null;
                  }}
                >
                  {render(item)}
                  <ItemActions
                    item={item}
                    onMove={
                      s.search ? undefined : (direction) => store.reorderItems(moveSidebarItem(group.items, index, index + direction))
                    }
                    first={index === 0}
                    last={index === group.items.length - 1}
                  />
                </div>
              ))}
        </div>
      </section>
    );
  };
  return sidebarGroups(items, s.sidebarGrouping).map(renderGroup);
}

export function ItemActions({
  item,
  onMove,
  first,
  last,
  children,
}: {
  item: SidebarItem;
  onMove?: (direction: number) => Promise<void>;
  first?: boolean;
  last?: boolean;
  children?: ReactNode;
}) {
  const { actions: store } = useWorkspace();
  const popover = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const archived = item.kind === 'case' ? item.value.status === 'archived' : !!item.value.hiddenAt;
  const working = item.kind === 'run' && !terminal(item.value);
  const label = `${item.kind} ${sidebarItemKey(item)}`;
  const act = (task: () => Promise<unknown>) => {
    popover.current?.hidePopover();
    setBusy(true);
    void task()
      .catch(store.report)
      .finally(() => setBusy(false));
  };
  const show = (element: HTMLElement, position?: { x: number; y: number }) => {
    const rect = element.getBoundingClientRect(),
      menu = popover.current!;
    menu.showPopover();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, position?.x ?? rect.right - bounds.width)) + 'px';
    menu.style.top = Math.max(8, Math.min(window.innerHeight - bounds.height - 8, position?.y ?? rect.bottom + 4)) + 'px';
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
  return (
    <div
      className={children ? 'archive-item-actions' : 'item-actions'}
      tabIndex={children ? 0 : undefined}
      role={children ? 'group' : undefined}
      aria-label={children ? `Archived ${label}` : undefined}
      onKeyDown={(e) => {
        if (children && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
          e.preventDefault();
          show(e.currentTarget);
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        show(e.currentTarget, { x: e.clientX, y: e.clientY });
      }}
    >
      {children ?? (
        <button
          className="remove-item"
          aria-label={`Actions for ${label}`}
          title={`Actions for ${label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={(e) => (open ? popover.current?.hidePopover() : show(e.currentTarget))}
        >
          <Icon name="more" />
        </button>
      )}
      <div
        ref={popover}
        className="item-menu"
        role="menu"
        popover="auto"
        onToggle={(e) => setOpen((e.nativeEvent as ToggleEvent).newState === 'open')}
        onKeyDown={(e) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus();
        }}
      >
        {archived ? (
          <button role="menuitem" onClick={() => act(() => store.restoreItem(item))}>
            <Icon name="unarchive" />
            Unarchive
          </button>
        ) : (
          <>
            <button role="menuitem" onClick={() => act(() => store.organize(item, { pinned: !item.value.pinnedAt }))}>
              <Icon name="pin" />
              {item.value.pinnedAt ? 'Unpin' : 'Pin'}
            </button>
            <button
              role="menuitem"
              disabled={working}
              title={working ? 'Wait for this run to finish.' : undefined}
              onClick={() => act(() => store.organize(item, { settled: !item.value.settledAt }))}
            >
              <Icon name="check" />
              {item.value.settledAt ? 'Unsettle' : 'Settle'}
            </button>
            {onMove && (
              <>
                <button role="menuitem" disabled={first} onClick={() => act(() => onMove(-1))}>
                  Move up
                </button>
                <button role="menuitem" disabled={last} onClick={() => act(() => onMove(1))}>
                  Move down
                </button>
              </>
            )}
            <button
              role="menuitem"
              aria-label={`Archive ${label}`}
              disabled={working}
              title={working ? 'Wait for this run to finish. Cancel it separately if needed.' : 'Keep this item in Settings → Archived.'}
              onClick={() => act(() => (item.kind === 'case' ? store.removeCase(item.value) : store.removeJob(item.value.id)))}
            >
              <Icon name="archive" />
              Archive
            </button>
          </>
        )}
        <button
          role="menuitem"
          className="danger"
          disabled={working}
          title={working ? 'Wait for this run to finish. Cancel it separately if needed.' : undefined}
          onClick={() => {
            popover.current?.hidePopover();
            store.patch({ confirmDelete: item });
          }}
        >
          <Icon name="trash" />
          {archived ? 'Delete' : 'Delete…'}
        </button>
      </div>
    </div>
  );
}
