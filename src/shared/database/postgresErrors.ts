/**
 * The Postgres and Prisma error codes this system reacts to, named once.
 *
 * Each of these is load-bearing somewhere: a bare `'23505'` in a catch block is a decision about
 * concurrency written as a magic string, and the reader cannot tell whether it was deliberate.
 */
export const PG_ERROR = {
  /** unique_violation — two writers raced and the constraint decided the winner. */
  UNIQUE_VIOLATION: '23505',
  /** insufficient_privilege — the role is missing a grant. */
  INSUFFICIENT_PRIVILEGE: '42501',
  /** program_limit_exceeded — e.g. a btree index entry past the 2704-byte maximum. */
  PROGRAM_LIMIT_EXCEEDED: '54000',
  /** query_canceled — the role's statement_timeout fired. */
  QUERY_CANCELED: '57014',
} as const;

export const PRISMA_ERROR = {
  /** Unique constraint failed. */
  UNIQUE_CONSTRAINT: 'P2002',
  /** An operation failed because it depends on one or more records that were required but not found. */
  RECORD_NOT_FOUND: 'P2025',
} as const;

interface CodedError {
  code?: unknown;
  meta?: { code?: unknown };
}

/**
 * True when an error carries the given SQLSTATE.
 *
 * Prisma surfaces the raw code in two different places depending on whether the statement went
 * through the query engine or `$queryRaw`, so both are checked rather than making every call site
 * remember which one it is dealing with.
 */
export function hasPostgresCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as CodedError;
  return candidate.code === code || candidate.meta?.code === code;
}

/** True when an error is Prisma's own error with the given `Pxxxx` code. */
export function hasPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as CodedError).code === code;
}
