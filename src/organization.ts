import { z } from 'zod';

export type ItemOrganization = { pinnedAt?: string; settledAt?: string; sortOrder?: number };
export const organizationSchema = z
  .object({
    pinned: z.boolean().optional(),
    settled: z.boolean().optional(),
    sortOrder: z.number().finite().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Choose an organization change');

export function organizeItem<T extends ItemOrganization>(item: T, input: unknown): T {
  const changes = organizationSchema.parse(input);
  const next = { ...item };
  if (changes.pinned !== undefined) next.pinnedAt = changes.pinned ? (item.pinnedAt ?? new Date().toISOString()) : undefined;
  if (changes.settled !== undefined) {
    next.settledAt = changes.settled ? (item.settledAt ?? new Date().toISOString()) : undefined;
    if (changes.settled) next.pinnedAt = undefined;
  }
  if (changes.pinned) next.settledAt = undefined;
  if (changes.sortOrder !== undefined) next.sortOrder = changes.sortOrder;
  return next;
}
