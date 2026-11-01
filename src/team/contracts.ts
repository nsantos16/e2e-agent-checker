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
