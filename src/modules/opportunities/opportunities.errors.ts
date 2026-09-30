import { BadRequestError, ConflictError, ERROR_CODE, NotFoundError } from '@shared/errors';

/**
 * This module's domain errors, each carrying the code and message the API has always answered
 * with. Naming them here is what stops the same string being retyped — slightly differently — at
 * the next throw site.
 */

/** The stage named on create does not belong to both this workspace and the named pipeline. */
export class InvalidStageError extends BadRequestError {
  constructor() {
    super(
      ERROR_CODE.INVALID_STAGE,
      'stageId must name a stage in this workspace and in the named pipeline',
    );
  }
}

/**
 * No such opportunity in this workspace.
 *
 * Another tenant's opportunity is indistinguishable from one that does not exist — a 404 either
 * way, with nothing to probe.
 */
export class OpportunityNotFoundError extends NotFoundError {
  constructor() {
    super(ERROR_CODE.OPPORTUNITY_NOT_FOUND, 'Opportunity not found.');
  }
}

/** The move target is not a stage of this workspace and of the opportunity's own pipeline. */
export class InvalidTargetStageError extends BadRequestError {
  constructor() {
    super(
      ERROR_CODE.INVALID_TARGET_STAGE,
      'targetStageId must name a stage in this workspace and in the opportunity’s pipeline.',
    );
  }
}

/** The caller's `expectedVersion` no longer matches the stored row: someone else moved it first. */
export class VersionConflictError extends ConflictError {
  constructor(expectedVersion: number, currentVersion: number) {
    super(
      ERROR_CODE.VERSION_CONFLICT,
      'The opportunity changed since it was read; re-read it and retry.',
      { expectedVersion, currentVersion },
    );
  }
}

/** No such stage in this workspace. */
export class StageNotFoundError extends NotFoundError {
  constructor() {
    super(ERROR_CODE.STAGE_NOT_FOUND, 'stage not found');
  }
}

/**
 * The pagination cursor did not decode.
 *
 * A 400, never a silent restart from the beginning: a caller mid-walk would otherwise get the
 * first page again and loop forever with no error to act on.
 */
export class InvalidCursorError extends BadRequestError {
  constructor() {
    super(ERROR_CODE.INVALID_CURSOR, 'cursor is not a valid pagination cursor');
  }
}
