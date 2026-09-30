/**
 * Every machine-readable `error.code` this API can answer with.
 *
 * These strings are the API's contract: clients branch on them, so a typo at a throw site is a
 * silent breaking change that no type checker would catch while they were inline literals.
 */
export const ERROR_CODE = {
  // Request scope
  WORKSPACE_REQUIRED: 'workspace_required',
  WORKSPACE_INVALID: 'workspace_invalid',
  WORKSPACE_UNKNOWN: 'workspace_unknown',

  // Request envelope
  INVALID_JSON: 'invalid_json',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  INVALID_BODY: 'invalid_body',
  INVALID_QUERY: 'invalid_query',
  INVALID_CURSOR: 'invalid_cursor',
  NOT_FOUND: 'not_found',
  INTERNAL_ERROR: 'internal_error',

  // Identifiers
  INVALID_JOB_ID: 'invalid_job_id',
  INVALID_OPPORTUNITY_ID: 'invalid_opportunity_id',
  INVALID_STAGE_ID: 'invalid_stage_id',

  // Idempotency
  IDEMPOTENCY_KEY_REQUIRED: 'idempotency_key_required',
  IDEMPOTENCY_KEY_INVALID: 'idempotency_key_invalid',
  IDEMPOTENCY_KEY_CONFLICT: 'idempotency_key_conflict',

  // Domain
  JOB_NOT_FOUND: 'job_not_found',
  OPPORTUNITY_NOT_FOUND: 'opportunity_not_found',
  STAGE_NOT_FOUND: 'stage_not_found',
  INVALID_STAGE: 'invalid_stage',
  INVALID_TARGET_STAGE: 'invalid_target_stage',
  TARGET_STAGE_INVALID: 'target_stage_invalid',
  FILTER_STAGE_INVALID: 'filter_stage_invalid',
  CROSS_PIPELINE_MOVE: 'cross_pipeline_move',
  VERSION_CONFLICT: 'version_conflict',
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
