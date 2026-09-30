import { z } from 'zod';
import { OPPORTUNITY_STATUS } from '@modules/opportunities/opportunities.constants';

const uuid = z.string().uuid();

/**
 * `.strict()` is deliberate: a filter with a misspelled key would otherwise be silently ignored
 * and the caller would get a bulk move over a far wider set of rows than they asked for.
 */
export const bulkMoveFilterSchema = z
  .object({
    stageId: uuid.optional(),
    ownerId: uuid.optional(),
    status: z.enum(OPPORTUNITY_STATUS).optional(),
    valueMin: z.number().optional(),
    valueMax: z.number().optional(),
    createdFrom: z.iso.datetime({ offset: true }).optional(),
    createdTo: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((f) => f.valueMin === undefined || f.valueMax === undefined || f.valueMin <= f.valueMax, {
    message: 'valueMin must not exceed valueMax',
  })
  .refine(
    (f) => !f.createdFrom || !f.createdTo || Date.parse(f.createdFrom) <= Date.parse(f.createdTo),
    {
      // Instants, not strings. `2025-06-15T23:00:00+05:30` is 17:30Z and therefore *before*
      // `2025-06-15T18:00:00Z`, but a character comparison reads '23…' as greater than '18…' and
      // rejects a valid window — while waving through an inverted one written the other way round.
      message: 'createdFrom must not be after createdTo',
    },
  );

export const bulkMoveBodySchema = z
  .object({
    filter: bulkMoveFilterSchema,
    targetStageId: uuid,
  })
  .strict();

/** Guards the `:id` path param: an unparseable id must be a 400, not a Postgres cast error. */
export const jobIdParamSchema = z.object({ id: uuid }).strict();

export type BulkMoveFilter = z.infer<typeof bulkMoveFilterSchema>;
export type BulkMoveBody = z.infer<typeof bulkMoveBodySchema>;
export type JobIdParams = z.infer<typeof jobIdParamSchema>;
