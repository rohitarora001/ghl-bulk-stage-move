import { Router } from 'express';
import { ERROR_CODE } from '@shared/errors';
import { validate } from '@shared/middleware';
import type { BulkMoveController } from './bulk-move.controller';
import { requireIdempotencyKey } from './bulk-move.middleware';
import { bulkMoveBodySchema, jobIdParamSchema } from './bulk-move.schemas';

export function bulkMoveRoutes(controller: BulkMoveController): Router {
  const router = Router();

  router.post(
    '/jobs/bulk-move',
    requireIdempotencyKey(),
    validate(bulkMoveBodySchema, 'body', {
      code: ERROR_CODE.INVALID_BODY,
      message: 'request body is invalid',
    }),
    controller.submit,
  );

  router.get(
    '/jobs/:id',
    validate(jobIdParamSchema, 'params', {
      code: ERROR_CODE.INVALID_JOB_ID,
      message: 'job id must be a uuid',
      withDetails: false,
    }),
    controller.progress,
  );

  // No Idempotency-Key: the operation is naturally idempotent. A second call finds no failed
  // items and flips nothing, which is the same end state as calling once.
  router.post(
    '/jobs/:id/retry-failed',
    validate(jobIdParamSchema, 'params', {
      code: ERROR_CODE.INVALID_JOB_ID,
      message: 'job id must be a uuid',
      withDetails: false,
    }),
    controller.retryFailed,
  );

  return router;
}
