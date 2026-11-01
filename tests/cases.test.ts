import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CaseCatalog, assertRunnable } from '../src/cases.ts';
import type { QaseCase } from '../src/qase.ts';
const steps = [{ action: 'Submit a valid form', expected_result: 'Success message appears' }];
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-cases-'));
  const legacy = join(dir, 'legacy');
  mkdirSync(legacy);
  return { dir, legacy, catalog: new CaseCatalog(join(dir, 'catalog.json'), legacy) };
};

test('case CRUD validates activation, survives restart, rejects stale edits and never reuses archived IDs', () => {
  const { dir, legacy, catalog } = setup();
  try {
    const draft = catalog.create({ title: 'New feature', idempotencyKey: 'draft-1' });
    assert.equal(draft.project, 'LOCAL');
    assert.equal(draft.status, 'draft');
    assert.equal(catalog.create({ title: 'New feature', idempotencyKey: 'draft-1' }).id, draft.id);
    assert.throws(() => catalog.create({ title: 'Different', idempotencyKey: 'draft-1' }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.throws(() => assertRunnable(draft), { code: 'CASE_NOT_ACTIVE' });
    assert.throws(() => catalog.update('LOCAL', draft.id, { expectedRevision: draft.revision, changes: { status: 'active' } }), {
      code: 'CASE_INCOMPLETE',
    });
    assert.throws(() => catalog.create({ title: 'Bad', project: '../escape' }));
    assert.throws(() => catalog.create({ title: 'Bad', unrecognized: true }));
    const activated = catalog.update('LOCAL', draft.id, {
      expectedRevision: draft.revision,
      changes: { status: 'active', steps, tags: ['smoke'] },
    });
    assertRunnable(activated);
    assert.equal(activated.steps[0].position, 1);
    assert.notEqual(activated.revision, draft.revision);
    assert.throws(() => catalog.update('LOCAL', draft.id, { expectedRevision: draft.revision, changes: { title: 'Lost update' } }), {
      code: 'REVISION_CONFLICT',
    });
    const reloaded = new CaseCatalog(catalog.path, legacy);
    assert.equal(reloaded.get('LOCAL', draft.id).revision, activated.revision);
    const archived = reloaded.archive('LOCAL', draft.id, { expectedRevision: activated.revision });
    assert.equal(catalog.list().length, 0);
    assert.equal(catalog.list(true).length, 1);
    assert.throws(() => assertRunnable(archived), { code: 'CASE_NOT_ACTIVE' });
    assert.equal(catalog.create({ title: 'Next case' }).id, 2);
    const restored = catalog.update('LOCAL', draft.id, { expectedRevision: archived.revision, changes: { status: 'active' } });
    assert.equal(restored.id, draft.id);
    assert.equal(catalog.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Qase fixtures stay compatible; explicit sync protects local edits, archives and identity collisions', () => {
  const { dir, legacy, catalog } = setup();
  const remote: QaseCase = {
    project: 'QA',
    id: 7,
    url: 'https://app.qase.io/case/QA-7',
    title: 'Imported',
    description: null,
    preconditions: null,
    steps: steps.map((s, i) => ({ ...s, position: i + 1, data: null })),
  };
  try {
    writeFileSync(join(legacy, 'QA-7.json'), JSON.stringify(remote));
    const imported = catalog.get('QA', 7);
    assert.equal(catalog.list()[0].source.kind, 'qase');
    assert.throws(() => catalog.syncQase(remote), { code: 'REVISION_CONFLICT' });
    const refreshed = catalog.syncQase({ ...remote, title: 'Upstream edit' }, imported.revision);
    const local = catalog.update('QA', 7, { expectedRevision: refreshed.revision, changes: { title: 'Local edit' } });
    assert.throws(() => catalog.syncQase(remote, refreshed.revision, true), { code: 'REVISION_CONFLICT' });
    assert.throws(() => catalog.syncQase(remote, local.revision), { code: 'SYNC_CONFLICT' });
    assert.equal(catalog.get('QA', 7).title, 'Local edit');
    const overwritten = catalog.syncQase(remote, local.revision, true);
    assert.equal(overwritten.title, remote.title);
    const archived = catalog.archive('QA', 7, { expectedRevision: overwritten.revision });
    assert.throws(() => catalog.syncQase(remote, archived.revision), { code: 'SYNC_CONFLICT' });
    assert.equal(catalog.list().length, 0, 'legacy fixture does not resurrect an archived override');
    const own = catalog.create({ project: 'QA', title: 'Native' });
    assert.equal(own.id, 8);
    assert.throws(() => catalog.syncQase({ ...remote, id: own.id }, own.revision, true), { code: 'SOURCE_CONFLICT' });
    const added = catalog.syncQase({ ...remote, id: 9 });
    assert.equal(added.source.externalId, 'QA-9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archive restores drafts, organization persists, and deleted cases never reappear or reuse IDs', () => {
  const { dir, legacy, catalog } = setup();
  try {
    const draft = catalog.create({ title: 'Draft to restore', idempotencyKey: 'draft' });
    const pinned = catalog.organize('LOCAL', draft.id, { expectedRevision: draft.revision, changes: { pinned: true } });
    assert.ok(pinned.pinnedAt);
    const archived = catalog.archive('LOCAL', draft.id, { expectedRevision: pinned.revision });
    // Older archives did not retain the previous draft/active state.
    const saved = JSON.parse(readFileSync(catalog.path, 'utf8'));
    delete saved.cases['LOCAL-1'].archivedFromStatus;
    writeFileSync(catalog.path, JSON.stringify(saved));
    const restored = catalog.restore('LOCAL', draft.id, { expectedRevision: archived.revision });
    assert.equal(restored.status, 'draft');
    assert.equal(restored.pinnedAt, pinned.pinnedAt);
    const next = catalog.create({ title: 'Next' });
    const ordered = catalog.reorder([`LOCAL-${next.id}`, `LOCAL-${restored.id}`]);
    assert.equal(ordered[1].sortOrder, 1);
    assert.throws(() => catalog.reorder(['LOCAL-1', 'LOCAL-999']), { code: 'NOT_FOUND' });
    const current = catalog.get('LOCAL', next.id);
    catalog.remove('LOCAL', next.id, { expectedRevision: current.revision });
    assert.throws(() => new CaseCatalog(catalog.path, legacy).get('LOCAL', next.id), { code: 'NOT_FOUND' });
    assert.equal(
      catalog.list(true).some((c) => c.id === next.id),
      false,
    );
    assert.equal(catalog.create({ title: 'New ID' }).id, next.id + 1);
    const old = catalog.get('LOCAL', draft.id);
    catalog.remove('LOCAL', old.id, { expectedRevision: old.revision });
    assert.throws(() => catalog.create({ title: 'Draft to restore', idempotencyKey: 'draft' }), { code: 'CASE_DELETED' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
