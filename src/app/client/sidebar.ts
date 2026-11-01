import { caseKey, terminal } from './format.ts';
import type { SidebarItem } from './types.ts';
import type { SidebarGrouping } from './workspace.ts';

export const sidebarItemKey = (item: SidebarItem) => (item.kind === 'case' ? caseKey(item.value) : item.value.id);
export type SidebarGroup = { key: string; label: string; items: SidebarItem[]; rank: number; children?: SidebarGroup[] };
export function sidebarGroups(items: SidebarItem[], mode: SidebarGrouping): SidebarGroup[] {
  const groups = new Map<string, SidebarGroup>();
  for (const item of items) {
    const working = item.kind === 'run' && !terminal(item.value);
    const section = item.value.pinnedAt
      ? 'Pinned'
      : item.value.settledAt && !working
        ? 'Settled'
        : mode === 'project' || mode === 'project-status'
          ? item.value.project
          : mode === 'status'
            ? working
              ? 'Working'
              : item.kind === 'case' && item.value.status === 'draft'
                ? 'Drafts'
                : 'Active'
            : '';
    const rank = section === 'Pinned' ? 0 : section === 'Settled' ? 3 : section === 'Working' ? 2 : 1;
    const key = `${item.kind}:${mode}:${rank}:${section}`;
    if (!groups.has(key)) groups.set(key, { key, label: section, items: [], rank });
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map((group) => ({
      ...group,
      children:
        mode === 'project-status' && group.rank === 1
          ? sidebarGroups(group.items, 'status').map((child) => ({ ...child, key: group.key + ':' + child.key }))
          : undefined,
      items: group.items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (a.item.value.sortOrder ?? a.index) - (b.item.value.sortOrder ?? b.index) || a.index - b.index)
        .map(({ item }) => item),
    }));
}
export function moveSidebarItem(items: SidebarItem[], from: number, to: number) {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item) next.splice(to, 0, item);
  return next;
}
