import { Router } from 'express';
import { ApiError } from '../errors';
import {
  createOpportunityBodySchema,
  moveOpportunityBodySchema,
  opportunityIdParamSchema,
  stageIdParamSchema,
  stageListQuerySchema,
} from '../schemas';
import { createOpportunity, moveOpportunity } from '../services/opportunityService';
import { listStageOpportunities } from '../services/stageListService';

/**
 * Part 1's three endpoints. Every one of them takes its tenant from `req.workspaceId`, never from
 * the body — a caller-supplied workspace id in a payload is an invitation to write into someone
 * else's data.
 */
export function opportunitiesRouter(): Router {
  const router = Router();

  router.post('/opportunities', (req, res, next) => {
    const parsed = createOpportunityBodySchema.safeParse(req.body);
    if (!parsed.success) {
      next(ApiError.badRequest('invalid_body', 'request body is invalid', parsed.error.issues));
      return;
    }

    createOpportunity({ workspaceId: req.workspaceId, ...parsed.data })
      .then((opportunity) => {
        res.status(201).json(opportunity);
      })
      .catch(next);
  });

  router.post('/opportunities/:id/move', (req, res, next) => {
    const params = opportunityIdParamSchema.safeParse(req.params);
    if (!params.success) {
      next(ApiError.badRequest('invalid_opportunity_id', 'opportunity id must be a uuid'));
      return;
    }
    const parsed = moveOpportunityBodySchema.safeParse(req.body);
    if (!parsed.success) {
      next(ApiError.badRequest('invalid_body', 'request body is invalid', parsed.error.issues));
      return;
    }

    moveOpportunity({
      workspaceId: req.workspaceId,
      opportunityId: params.data.id,
      targetStageId: parsed.data.targetStageId,
      ...(parsed.data.expectedVersion === undefined
        ? {}
        : { expectedVersion: parsed.data.expectedVersion }),
    })
      .then((opportunity) => {
        res.status(200).json(opportunity);
      })
      .catch(next);
  });

  router.get('/stages/:stageId/opportunities', (req, res, next) => {
    const params = stageIdParamSchema.safeParse(req.params);
    if (!params.success) {
      next(ApiError.badRequest('invalid_stage_id', 'stage id must be a uuid'));
      return;
    }
    const query = stageListQuerySchema.safeParse(req.query);
    if (!query.success) {
      next(ApiError.badRequest('invalid_query', 'query parameters are invalid', query.error.issues));
      return;
    }

    listStageOpportunities({
      workspaceId: req.workspaceId,
      stageId: params.data.stageId,
      ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
      ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
    })
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  });

  return router;
}
