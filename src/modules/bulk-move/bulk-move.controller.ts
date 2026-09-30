import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '@shared/http/asyncHandler';
import { validated } from '@shared/middleware';
import type { BulkMoveBody, JobIdParams } from './bulk-move.schemas';
import type { BulkMoveService } from './bulk-move.service';

export interface BulkMoveController {
  submit: RequestHandler;
  progress: RequestHandler;
  retryFailed: RequestHandler;
}

export function createBulkMoveController(service: BulkMoveService): BulkMoveController {
  return {
    submit: asyncHandler(async (req: Request, res: Response) => {
      const body = validated<BulkMoveBody>(req, 'body');

      const result = await service.submitBulkMoveJob({
        workspaceId: req.workspaceId,
        idempotencyKey: req.idempotencyKey!,
        filter: body.filter,
        targetStageId: body.targetStageId,
      });

      // 202 says "accepted, work is happening elsewhere"; a replayed key returns 200 because
      // nothing new was accepted.
      res.status(result.created ? 202 : 200).json({
        jobId: result.jobId,
        totalCount: result.totalCount,
        matchedCount: result.matchedCount,
        truncated: result.truncated,
      });
    }),

    progress: asyncHandler(async (req: Request, res: Response) => {
      const { id } = validated<JobIdParams>(req, 'params');

      res.status(200).json(await service.getJobProgress(req.workspaceId, id));
    }),

    retryFailed: asyncHandler(async (req: Request, res: Response) => {
      const { id } = validated<JobIdParams>(req, 'params');

      res.status(200).json(await service.retryFailedItems(req.workspaceId, id));
    }),
  };
}
