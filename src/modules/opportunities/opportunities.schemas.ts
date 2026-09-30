import { z } from 'zod';
import { MAX_PAGE_SIZE, OPPORTUNITY_STATUS } from './opportunities.constants';

const uuid = z.string().uuid();

/**
 * `.strict()` throughout: an unexpected or misspelled key is a 400, never silently ignored. A
 * caller who typed a field name wrong should be told, not served a result that quietly ignored
 * half of what they asked for.
 */
export const createOpportunityBodySchema = z
  .object({
    pipelineId: uuid,
    stageId: uuid,
    name: z.string().min(1).max(200),
    // NUMERIC(14,2) in the database. Bounded here so an out-of-range number is a 400 rather than a
    // Postgres numeric overflow surfacing as a 500.
    value: z.number().min(0).max(999_999_999_999),
    ownerId: uuid,
    status: z.enum(OPPORTUNITY_STATUS).optional(),
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
    limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  })
  .strict();

export type CreateOpportunityBody = z.infer<typeof createOpportunityBodySchema>;
export type MoveOpportunityBody = z.infer<typeof moveOpportunityBodySchema>;
export type OpportunityIdParams = z.infer<typeof opportunityIdParamSchema>;
export type StageIdParams = z.infer<typeof stageIdParamSchema>;
export type StageListQuery = z.infer<typeof stageListQuerySchema>;
