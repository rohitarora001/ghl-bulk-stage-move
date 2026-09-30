import { Router } from 'express';
import { ApiError } from '../errors';
import { bulkMoveBodySchema, jobIdParamSchema } from '../schemas';
import { submitBulkMoveJob } from '../services/jobService';
import { getJobProgress } from '../services/progressService';
import { retryFailedItems } from '../services/retryService';

/** Comfortably under the 2704-byte btree index-entry limit, and longer than any sane UUID key. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export function jobsRouter(): Router {
  const router = Router();

  router.post('/jobs/bulk-move', (req, res, next) => {
    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey) {
      next(ApiError.badRequest('idempotency_key_required', 'Idempotency-Key header is required'));
      return;
    }
    // The key is a btree index column. Past ~2704 bytes Postgres refuses the index entry outright
    // (SQLSTATE 54000), which reaches the caller as a 500 for what is plainly their input; Node's
    // 16KB header cap is far too loose to stop it. Bounded well below the index limit instead.
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      next(
        ApiError.badRequest(
          'idempotency_key_invalid',
          `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
        ),
      );
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

  router.get('/jobs/:id', (req, res, next) => {
    const parsed = jobIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      next(ApiError.badRequest('invalid_job_id', 'job id must be a uuid'));
      return;
    }

    getJobProgress(req.workspaceId, parsed.data.id)
      .then((progress) => {
        res.status(200).json(progress);
      })
      .catch(next);
  });

  // No Idempotency-Key: the operation is naturally idempotent. A second call finds no failed
  // items and flips nothing, which is the same end state as calling once.
  router.post('/jobs/:id/retry-failed', (req, res, next) => {
    const parsed = jobIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      next(ApiError.badRequest('invalid_job_id', 'job id must be a uuid'));
      return;
    }

    retryFailedItems(req.workspaceId, parsed.data.id)
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  });

  return router;
}
