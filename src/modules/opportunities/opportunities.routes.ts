import { Router } from 'express';
import { ERROR_CODE } from '@shared/errors';
import { validate } from '@shared/middleware';
import type { OpportunitiesController } from './opportunities.controller';
import {
  createOpportunityBodySchema,
  moveOpportunityBodySchema,
  opportunityIdParamSchema,
  stageIdParamSchema,
  stageListQuerySchema,
} from './opportunities.schemas';

/**
 * Part 1's three endpoints: path, validation, handler. No logic lives here.
 *
 * The id schemas answer without `details` while the body and query schemas include zod's issue
 * list — the codes and shapes each endpoint has always returned.
 */
export function opportunitiesRoutes(controller: OpportunitiesController): Router {
  const router = Router();

  router.post(
    '/opportunities',
    validate(createOpportunityBodySchema, 'body', {
      code: ERROR_CODE.INVALID_BODY,
      message: 'request body is invalid',
    }),
    controller.create,
  );

  router.post(
    '/opportunities/:id/move',
    validate(opportunityIdParamSchema, 'params', {
      code: ERROR_CODE.INVALID_OPPORTUNITY_ID,
      message: 'opportunity id must be a uuid',
      withDetails: false,
    }),
    validate(moveOpportunityBodySchema, 'body', {
      code: ERROR_CODE.INVALID_BODY,
      message: 'request body is invalid',
    }),
    controller.move,
  );

  router.get(
    '/stages/:stageId/opportunities',
    validate(stageIdParamSchema, 'params', {
      code: ERROR_CODE.INVALID_STAGE_ID,
      message: 'stage id must be a uuid',
      withDetails: false,
    }),
    validate(stageListQuerySchema, 'query', {
      code: ERROR_CODE.INVALID_QUERY,
      message: 'query parameters are invalid',
    }),
    controller.listByStage,
  );

  return router;
}
