import { BadRequestError, ConflictError, ERROR_CODE, NotFoundError } from '@shared/errors';
import { MAX_IDEMPOTENCY_KEY_LENGTH } from './bulk-move.constants';

/** No `Idempotency-Key` header. Submission is not idempotent without one, so it is required. */
export class IdempotencyKeyRequiredError extends BadRequestError {
  constructor() {
    super(ERROR_CODE.IDEMPOTENCY_KEY_REQUIRED, 'Idempotency-Key header is required');
  }
}

/** A key long enough to break the btree index it is stored in. */
export class IdempotencyKeyInvalidError extends BadRequestError {
  constructor() {
    super(
      ERROR_CODE.IDEMPOTENCY_KEY_INVALID,
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
}

/**
 * The key was already used — for something else.
 *
 * Answering this with the original job's id and a 200 is the worst available outcome: the caller
 * is told their second, different bulk move was accepted, and nothing will ever perform it.
 */
export class IdempotencyKeyConflictError extends ConflictError {
  constructor() {
    super(
      ERROR_CODE.IDEMPOTENCY_KEY_CONFLICT,
      'Idempotency-Key was already used for a different filter or target stage',
    );
  }
}

/** The move target is not a stage of this workspace. */
export class TargetStageInvalidError extends BadRequestError {
  constructor() {
    super(ERROR_CODE.TARGET_STAGE_INVALID, 'targetStageId does not name a stage in this workspace');
  }
}

/** The filter names a stage that is not in this workspace. */
export class FilterStageInvalidError extends BadRequestError {
  constructor() {
    super(
      ERROR_CODE.FILTER_STAGE_INVALID,
      'filter.stageId does not name a stage in this workspace',
    );
  }
}

/**
 * Source and target stages live in different pipelines.
 *
 * Refused rather than performed: moving a record across pipelines would leave `pipeline_id` and
 * `stage_id` disagreeing, and deciding what should happen to `pipeline_id` is out of scope.
 */
export class CrossPipelineMoveError extends BadRequestError {
  constructor() {
    super(
      ERROR_CODE.CROSS_PIPELINE_MOVE,
      'targetStageId belongs to a different pipeline than filter.stageId',
    );
  }
}

/**
 * No such job in this workspace.
 *
 * Scoped by workspace in the same predicate that finds the row, so another tenant's job is
 * indistinguishable from one that does not exist.
 */
export class JobNotFoundError extends NotFoundError {
  constructor() {
    super(ERROR_CODE.JOB_NOT_FOUND, 'job not found');
  }
}
