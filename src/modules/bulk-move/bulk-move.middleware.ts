import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { IDEMPOTENCY_KEY_HEADER, MAX_IDEMPOTENCY_KEY_LENGTH } from './bulk-move.constants';
import { IdempotencyKeyInvalidError, IdempotencyKeyRequiredError } from './bulk-move.errors';

/**
 * The `Idempotency-Key` policy, applied before the route runs.
 *
 * It is validation, not business logic, so it belongs in middleware rather than in the handler —
 * and it has to happen before the snapshot query, because a key too long for its btree index
 * fails at write time as a 500 for what is plainly the caller's input.
 */
export function requireIdempotencyKey(): RequestHandler {
  return function requireIdempotencyKeyMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    const key = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!key) {
      next(new IdempotencyKeyRequiredError());
      return;
    }
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      next(new IdempotencyKeyInvalidError());
      return;
    }

    req.idempotencyKey = key;
    next();
  };
}
