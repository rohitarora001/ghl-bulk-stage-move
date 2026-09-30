/**
 * The key is a btree index column. Past ~2704 bytes Postgres refuses the index entry outright
 * (SQLSTATE 54000), which reaches the caller as a 500 for what is plainly their input; Node's 16KB
 * header cap is far too loose to stop it. Bounded well below the index limit instead.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** The header that carries it. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** `jobs.status`. */
export const JOB_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

/** How `GET /jobs/:id` summarises a job for a human. */
export const JOB_CLASSIFICATION = {
  RUNNING: 'running',
  BACKING_OFF: 'backing_off',
  STUCK: 'stuck',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
