import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '@shared/http/asyncHandler';
import { validated } from '@shared/middleware';
import type {
  CreateOpportunityBody,
  MoveOpportunityBody,
  OpportunityIdParams,
  StageIdParams,
  StageListQuery,
} from './opportunities.schemas';
import type { OpportunitiesService } from './opportunities.service';

export interface OpportunitiesController {
  create: RequestHandler;
  move: RequestHandler;
  listByStage: RequestHandler;
}

/**
 * HTTP in, HTTP out.
 *
 * Every handler takes its tenant from `req.workspaceId` and never from the body: a
 * caller-supplied workspace id in a payload is an invitation to write into someone else's data.
 * Validation happened in middleware, so these read `validated(req, …)` and nothing raw.
 */
export function createOpportunitiesController(
  service: OpportunitiesService,
): OpportunitiesController {
  return {
    create: asyncHandler(async (req: Request, res: Response) => {
      const body = validated<CreateOpportunityBody>(req, 'body');

      const opportunity = await service.createOpportunity({
        workspaceId: req.workspaceId,
        ...body,
      });

      res.status(201).json(opportunity);
    }),

    move: asyncHandler(async (req: Request, res: Response) => {
      const { id } = validated<OpportunityIdParams>(req, 'params');
      const body = validated<MoveOpportunityBody>(req, 'body');

      const opportunity = await service.moveOpportunity({
        workspaceId: req.workspaceId,
        opportunityId: id,
        targetStageId: body.targetStageId,
        ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
      });

      res.status(200).json(opportunity);
    }),

    listByStage: asyncHandler(async (req: Request, res: Response) => {
      const { stageId } = validated<StageIdParams>(req, 'params');
      const query = validated<StageListQuery>(req, 'query');

      const page = await service.listStageOpportunities({
        workspaceId: req.workspaceId,
        stageId,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });

      res.status(200).json(page);
    }),
  };
}
