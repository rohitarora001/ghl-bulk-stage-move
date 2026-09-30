import { z } from 'zod';

/**
 * Request shapes, validated at the edge. `.strict()` is deliberate: a filter with a misspelled
 * key would otherwise be silently ignored and the caller would get a bulk move over a far wider
 * set of rows than they asked for.
 */

const uuid = z.string().uuid();

export const bulkMoveFilterSchema = z
  .object({
    stageId: uuid.optional(),
    ownerId: uuid.optional(),
    status: z.enum(['open', 'won', 'lost', 'abandoned']).optional(),
    valueMin: z.number().optional(),
    valueMax: z.number().optional(),
    createdFrom: z.iso.datetime({ offset: true }).optional(),
    createdTo: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((f) => f.valueMin === undefined || f.valueMax === undefined || f.valueMin <= f.valueMax, {
    message: 'valueMin must not exceed valueMax',
  })
  .refine((f) => !f.createdFrom || !f.createdTo || f.createdFrom <= f.createdTo, {
    message: 'createdFrom must not be after createdTo',
  });

export const bulkMoveBodySchema = z
  .object({
    filter: bulkMoveFilterSchema,
    targetStageId: uuid,
  })
  .strict();

export type BulkMoveFilter = z.infer<typeof bulkMoveFilterSchema>;
export type BulkMoveBody = z.infer<typeof bulkMoveBodySchema>;

/** Guards the `:id` path param: an unparseable id must be a 400, not a Postgres cast error. */
export const jobIdParamSchema = z.object({ id: uuid }).strict();

export const createOpportunityBodySchema = z
  .object({
    pipelineId: uuid,
    stageId: uuid,
    name: z.string().min(1).max(200),
    // NUMERIC(14,2) in the database. Bounded here so an out-of-range number is a 400 rather than a
    // Postgres numeric overflow surfacing as a 500.
    value: z.number().min(0).max(999_999_999_999),
    ownerId: uuid,
    status: z.enum(['open', 'won', 'lost', 'abandoned']).optional(),
  })
  .strict();

export const moveOpportunityBodySchema = z
  .object({
    targetStageId: uuid,
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

export const opportunityIdParamSchema = z.object({ id: uuid }).strict();
export const stageIdParamSchema = z.object({ stageId: uuid }).strict();

export const stageListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();
