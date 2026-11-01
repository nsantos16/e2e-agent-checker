import { test } from 'node:test';
import assert from 'node:assert/strict';
import { organizeItem } from '../src/organization.ts';
import { sidebarGroups, moveSidebarItem } from '../src/app/client/sidebar.ts';
import type { SidebarItem } from '../src/app/client/types.ts';

const item = (id: string, project = 'LOCAL', changes = {}): SidebarItem => ({
  kind: 'run',
  value: { id, project, caseId: 1, status: 'done', worktree: '', role: '', log: [], createdAt: '2026-01-01T00:00:00Z', ...changes },
});
test('project folders and status sections preserve pins, working state and settlement', () => {
  const items = [
    item('a'),
    item('b', 'DEMO'),
    item('pin', 'DEMO', { pinnedAt: 'now' }),
    item('settled', 'LOCAL', { settledAt: 'now' }),
    item('running', 'LOCAL', { status: 'running' }),
  ];
  assert.deepEqual(
    sidebarGroups(items, 'project').map((g) => [g.label, g.items.length]),
    [
      ['Pinned', 1],
      ['DEMO', 1],
      ['LOCAL', 2],
      ['Settled', 1],
    ],
  );
  assert.deepEqual(
    sidebarGroups(items, 'status').map((g) => [g.label, g.items.length]),
    [
      ['Pinned', 1],
      ['Active', 2],
      ['Working', 1],
      ['Settled', 1],
    ],
  );
  const combined = sidebarGroups(items, 'project-status');
  assert.deepEqual(
    combined.map((g) => g.label),
    ['Pinned', 'DEMO', 'LOCAL', 'Settled'],
  );
  assert.deepEqual(
    combined.find((g) => g.label === 'LOCAL')?.children?.map((g) => [g.label, g.items.length]),
    [
      ['Active', 1],
      ['Working', 1],
    ],
  );
  assert.equal(organizeItem({ pinnedAt: 'old' }, { settled: true }).pinnedAt, undefined);
  assert.equal(organizeItem({ settledAt: 'old' }, { pinned: true }).settledAt, undefined);
});
test('saved item order survives new list instances and reordering leaves the input intact', () => {
  const items = [item('a', 'LOCAL', { sortOrder: 1 }), item('b', 'LOCAL', { sortOrder: 0 })];
  assert.deepEqual(
    sidebarGroups(structuredClone(items), 'project')[0].items.map((i) => i.value.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    moveSidebarItem(items, 0, 1).map((i) => i.value.id),
    ['b', 'a'],
  );
  assert.equal(items[0].value.id, 'a');
});
