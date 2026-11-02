import { z } from 'zod';

export const roleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export const caseDraftSchema = z
  .object({
    project: z
      .string()
      .regex(/^[A-Z0-9_]{1,32}$/)
      .default('LOCAL'),
    title: z.string().trim().min(1).max(300),
    description: z.string().max(12000).default(''),
    preconditions: z.string().max(12000).default(''),
    suitePath: z.string().max(300).default(''),
    priority: z.number().int().min(0).max(6).default(0),
    severity: z.number().int().min(0).max(6).default(0),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    status: z.enum(['draft', 'active', 'archived']).default('draft'),
    steps: z
      .array(
        z
          .object({
            action: z.string().max(6000),
            expectedResult: z.string().max(6000),
            data: z.string().max(6000).default(''),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict()
  .refine(
    (c) =>
      c.status !== 'active' ||
      (c.steps.length > 0 &&
        c.steps.every((s) => s.action.trim() && s.expectedResult.trim())),
    {
      message: 'Active cases require steps with actions and expected results.',
      path: ['steps'],
    },
  );
export const teamCaseSchema = caseDraftSchema.safeExtend({
  id: z.uuid(),
  orgId: z.uuid(),
  revision: z.number().int().positive(),
  createdByUserId: z.uuid().nullable(),
  updatedByUserId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const createCaseRequest = z
  .object({ id: z.uuid(), data: caseDraftSchema })
  .strict();
export const updateCaseRequest = z
  .object({
    expectedRevision: z.number().int().positive(),
    data: caseDraftSchema,
  })
  .strict();
export const caseListRequest = z.object({
  search: z.string().trim().max(200).default(''),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const casePageSchema = z.object({
  items: z.array(teamCaseSchema),
  nextCursor: z.uuid().nullable(),
});
export const actorSchema = z.object({
  userId: z.uuid(),
  orgId: z.uuid(),
  role: roleSchema,
  name: z.string(),
  organizationName: z.string(),
});
export type TeamCase = z.infer<typeof teamCaseSchema>;
export type CaseDraft = z.infer<typeof caseDraftSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type Role = z.infer<typeof roleSchema>;
export const canEdit = (role: Role) => role !== 'viewer';

// Shared metadata only. Publishing a record does not schedule local execution.
export const runDataSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    project: z
      .string()
      .regex(/^[A-Z0-9_]{1,32}$/)
      .default('LOCAL'),
    caseLabel: z.string().max(100).default(''),
    status: z.enum([
      'queued',
      'running',
      'cancelling',
      'done',
      'failed',
      'cancelled',
      'interrupted',
    ]),
    outcome: z
      .enum(['pass', 'fail', 'blocked', 'codify-failed'])
      .nullable()
      .default(null),
    provider: z.string().max(100).default(''),
    model: z.string().max(200).default(''),
    environmentName: z.string().max(200).default(''),
    summary: z.string().max(12000).default(''),
    startedAt: z.iso.datetime().nullable().default(null),
    finishedAt: z.iso.datetime().nullable().default(null),
  })
  .strict()
  .refine((run) => run.outcome === null || run.status === 'done', {
    message: 'Only a completed run can have a verification outcome.',
    path: ['outcome'],
  })
  .refine(
    (run) =>
      !run.startedAt || !run.finishedAt || run.finishedAt >= run.startedAt,
    {
      message: 'A run cannot finish before it starts.',
      path: ['finishedAt'],
    },
  );
export const runUserSchema = z.object({ id: z.uuid(), name: z.string() });
export const teamRunSchema = runDataSchema.safeExtend({
  id: z.uuid(),
  orgId: z.uuid(),
  initiatedBy: runUserSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const createRunRequest = z
  .object({ id: z.uuid(), data: runDataSchema })
  .strict();
export const updateRunRequest = z
  .object({
    expectedRevision: z.number().int().positive(),
    data: runDataSchema,
  })
  .strict();
export const runListRequest = z.object({
  userId: z.uuid().optional(),
  after: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const runStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export const runPageSchema = z.object({
  items: z.array(teamRunSchema),
  users: z.array(runUserSchema),
  stats: runStatsSchema,
  nextCursor: z.string().nullable(),
});
export type RunData = z.infer<typeof runDataSchema>;
export type TeamRun = z.infer<typeof teamRunSchema>;
export type RunUser = z.infer<typeof runUserSchema>;
export type RunStats = z.infer<typeof runStatsSchema>;
