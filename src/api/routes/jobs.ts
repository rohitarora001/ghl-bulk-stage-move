import { Router } from 'express';
import { ApiError } from '../errors';
import { bulkMoveBodySchema } from '../schemas';
import { submitBulkMoveJob } from '../services/jobService';

export function jobsRouter(): Router {
  const router = Router();

  router.post('/jobs/bulk-move', (req, res, next) => {
    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey) {
      next(ApiError.badRequest('idempotency_key_required', 'Idempotency-Key header is required'));
      return;
    }

    const parsed = bulkMoveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      next(ApiError.badRequest('invalid_body', 'request body is invalid', parsed.error.issues));
      return;
    }

    submitBulkMoveJob({
      workspaceId: req.workspaceId,
      idempotencyKey,
      filter: parsed.data.filter,
      targetStageId: parsed.data.targetStageId,
    })
      .then((result) => {
        // 202 says "accepted, work is happening elsewhere"; a replayed key returns 200 because
        // nothing new was accepted.
        res.status(result.created ? 202 : 200).json({
          jobId: result.jobId,
          totalCount: result.totalCount,
          matchedCount: result.matchedCount,
          truncated: result.truncated,
        });
      })
      .catch(next);
  });

  return router;
}
