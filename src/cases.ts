import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { QaseCase } from './qase.ts';

export const projectSchema = z.string().regex(/^[A-Z0-9_]{1,32}$/);
const text = z.string().max(12000).nullable();
export const caseFields = {
  title: z.string().trim().min(1).max(300),
  description: text,
  preconditions: text,
  suite_path: z.string().max(300),
  priority: z.number().int().min(0).max(6),
  severity: z.number().int().min(0).max(6),
  tags: z.array(z.string().trim().min(1).max(60)).max(30),
  status: z.enum(['draft', 'active', 'archived']),
  steps: z
    .array(
      z
        .object({
          action: z.string().max(6000).nullable(),
          expected_result: z.string().max(6000).nullable(),
          data: z.string().max(6000).nullable().optional(),
        })
        .strict(),
    )
    .max(100),
};
export const createCaseSchema = z
  .object({
    project: projectSchema.default('LOCAL'),
    ...caseFields,
    description: text.default(null),
    preconditions: text.default(null),
    suite_path: caseFields.suite_path.default(''),
    priority: caseFields.priority.default(0),
    severity: caseFields.severity.default(0),
    tags: caseFields.tags.default([]),
    status: z.enum(['draft', 'active']).default('draft'),
    steps: caseFields.steps.default([]),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
export const casePatchSchema = z
  .object(caseFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one changed field');
export const updateCaseSchema = z.object({ expectedRevision: z.string().min(1), changes: casePatchSchema }).strict();
export const deleteCaseSchema = z.object({ expectedRevision: z.string().min(1) }).strict();
export const syncCaseSchema = z
  .object({
    project: projectSchema,
    caseId: z.number().int().positive(),
    expectedRevision: z.string().min(1).optional(),
    overwriteLocal: z.boolean().default(false),
  })
  .strict();
export type TestCase = QaseCase & {
  revision: string;
  status: 'draft' | 'active' | 'archived';
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  source: { kind: 'local' | 'qase'; externalId?: string; syncedAt?: string; contentHash?: string };
};
type Catalog = { cases: Record<string, TestCase>; creates: Record<string, { hash: string; key: string }> };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const keyOf = (project: string, id: number) => `${projectSchema.parse(project)}-${z.number().int().positive().parse(id)}`;
const content = (c: QaseCase) => ({
  title: c.title,
  description: c.description,
  preconditions: c.preconditions,
  suite_path: c.suite_path ?? '',
  priority: c.priority ?? 0,
  severity: c.severity ?? 0,
  steps: c.steps,
});
// Revision is the editing boundary; the digest also catches damaged snapshots or
// externally edited legacy fixtures that retained their revision.
export const caseCompatibility = (c: TestCase) => ({
  project: c.project,
  id: c.id,
  revision: c.revision,
  sha256: hash({ ...content(c), status: c.status, tags: c.tags }),
});
export const caseSummary = (c: TestCase) => ({
  project: c.project,
  id: c.id,
  title: c.title,
  revision: c.revision,
  status: c.status,
  tags: c.tags,
  suite: c.suite_path ?? '',
  priority: c.priority,
  steps: c.steps.length,
  url: c.url,
  source: { kind: c.source.kind, externalId: c.source.externalId, syncedAt: c.source.syncedAt },
});
export function assertRunnable(c: TestCase) {
  if (c.status !== 'active') fail('CASE_NOT_ACTIVE', `${c.project}-${c.id} is ${c.status}; activate it before running`);
  if (!c.steps.length || c.steps.some((s) => !s.action?.trim() || !s.expected_result?.trim()))
    fail('CASE_INCOMPLETE', 'An active case needs steps with both actions and expected results');
}

// All writes go through the single local HTTP service. Read current state before each
// synchronous atomic commit so async imports cannot overwrite a newer local edit.
export class CaseCatalog {
  readonly path: string;
  readonly legacyDir: string;
  constructor(path: string, legacyDir: string) {
    this.path = path;
    this.legacyDir = legacyDir;
  }
  private read(): Catalog {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { cases: {}, creates: {} };
  }
  private save(db: Catalog) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  private legacy(project: string, id: number): TestCase | undefined {
    const path = join(this.legacyDir, keyOf(project, id) + '.json');
    if (!existsSync(path)) return;
    const c: QaseCase = JSON.parse(readFileSync(path, 'utf8'));
    return {
      ...c,
      revision: hash(c),
      status: 'active',
      tags: [],
      source: { kind: 'qase', externalId: keyOf(project, id), contentHash: hash(content(c)) },
    };
  }
  get(project: string, id: number): TestCase {
    return (
      this.read().cases[keyOf(project, id)] ?? this.legacy(project, id) ?? fail('NOT_FOUND', 'Case not found. Create or import it first.')
    );
  }
  list(includeArchived = false) {
    const cases = new Map<string, TestCase>();
    for (const file of existsSync(this.legacyDir) ? readdirSync(this.legacyDir) : []) {
      const match = file.match(/^([A-Z0-9_]+)-(\d+)\.json$/);
      if (match) cases.set(file.slice(0, -5), this.legacy(match[1], Number(match[2]))!);
    }
    for (const [key, c] of Object.entries(this.read().cases)) cases.set(key, c);
    return [...cases.values()]
      .filter((c) => includeArchived || c.status !== 'archived')
      .sort((a, b) => (a.suite_path ?? '').localeCompare(b.suite_path ?? '') || a.project.localeCompare(b.project) || a.id - b.id);
  }
  create(input: unknown) {
    const { idempotencyKey, ...fields } = createCaseSchema.parse(input),
      db = this.read();
    const prior = idempotencyKey && Object.hasOwn(db.creates, idempotencyKey) ? db.creates[idempotencyKey] : undefined;
    if (prior) {
      if (prior.hash !== hash(fields)) fail('IDEMPOTENCY_CONFLICT', 'Creation key already used with different case data');
      return db.cases[prior.key];
    }
    const id =
      Math.max(
        0,
        ...this.list(true)
          .filter((c) => c.project === fields.project)
          .map((c) => c.id),
      ) + 1;
    const now = new Date().toISOString();
    const c: TestCase = {
      ...fields,
      id,
      url: '',
      steps: fields.steps.map((s, i) => ({ ...s, position: i + 1, data: s.data ?? null })),
      revision: randomUUID(),
      source: { kind: 'local' },
      createdAt: now,
      updatedAt: now,
    };
    if (c.status === 'active') assertRunnable(c);
    const key = keyOf(c.project, id);
    db.cases[key] = c;
    if (idempotencyKey) db.creates = { ...db.creates, [idempotencyKey]: { hash: hash(fields), key } };
    this.save(db);
    return c;
  }
  update(project: string, id: number, input: unknown) {
    const { expectedRevision, changes } = updateCaseSchema.parse(input),
      db = this.read();
    const old = this.get(project, id);
    if (old.revision !== expectedRevision) fail('REVISION_CONFLICT', 'Case changed. Read get_case and reapply your changes.');
    const c: TestCase = {
      ...old,
      ...changes,
      steps: changes.steps ? changes.steps.map((s, i) => ({ ...s, position: i + 1, data: s.data ?? null })) : old.steps,
      revision: randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    if (c.status === 'active') assertRunnable(c);
    db.cases[keyOf(project, id)] = c;
    this.save(db);
    return c;
  }
  archive(project: string, id: number, input: unknown) {
    const { expectedRevision } = deleteCaseSchema.parse(input);
    return this.update(project, id, { expectedRevision, changes: { status: 'archived' } });
  }
  syncQase(remote: QaseCase, expectedRevision?: string, overwriteLocal = false) {
    const key = keyOf(remote.project, remote.id),
      db = this.read();
    const old = db.cases[key] ?? this.legacy(remote.project, remote.id);
    if (old) {
      if (old.source.kind !== 'qase') fail('SOURCE_CONFLICT', 'This ID belongs to a local case; use another project for Qase imports');
      if (old.revision !== expectedRevision) fail('REVISION_CONFLICT', 'Read get_case and pass its current revision before syncing');
      if (!overwriteLocal && (old.status === 'archived' || hash(content(old)) !== old.source.contentHash))
        fail('SYNC_CONFLICT', 'Local case has edits or is archived. Review both versions before retrying with overwriteLocal:true.');
    } else if (expectedRevision) fail('REVISION_CONFLICT', 'Case does not exist');
    const now = new Date().toISOString();
    const c: TestCase = {
      ...remote,
      revision: randomUUID(),
      status: old?.status === 'draft' ? 'draft' : 'active',
      tags: old?.tags ?? [],
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      source: { kind: 'qase', externalId: key, syncedAt: now, contentHash: hash(content(remote)) },
    };
    db.cases[key] = c;
    this.save(db);
    return c;
  }
}
const root = new URL('..', import.meta.url).pathname;
export const caseCatalog = new CaseCatalog(process.env.E2E_CASES_PATH ?? join(root, '.state/cases.json'), join(root, 'fixtures/qase'));
