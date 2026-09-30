import type { PrismaClient } from '@prisma/client';
import { getConfig } from '@config';

/**
 * Every query the worker loop needs that is not the chunk transaction itself.
 *
 * All of them are set-based and single-statement on purpose. A read followed by a write is a race
 * whenever anything else can touch the same rows, and in this system something always can:
 * another loop, the finalize sweep, or an operator calling retry-failed.
 */

/**
 * The next job worth working on.
 *
 * `EXISTS (... claimable ...)` is the important half. Scoping only to `status = 'running'` would
 * keep handing back a job whose every remaining item is backed off into the future; the loop
 * would claim nothing, and — because the picker is ordered by progress — would be handed the same
 * useless job again, starving jobs that do have work. Ordering by `last_progress_at ASC NULLS
 * FIRST` puts brand-new jobs at the front and rotates between jobs that are all making progress.
 */
export async function pickJobWithClaimableWork(prisma: PrismaClient): Promise<string | null> {
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT j.id FROM jobs j
    WHERE j.status = 'running'
      AND EXISTS (
        SELECT 1 FROM job_items ji
        WHERE ji.job_id = j.id AND ji.status = 'pending' AND ji.next_attempt_at <= now()
      )
    ORDER BY j.last_progress_at ASC NULLS FIRST
    LIMIT 1
  `;
  return row?.id ?? null;
}

/**
 * Records that a chunk committed.
 *
 * Runs AFTER the chunk transaction commits, never inside it: holding this row's lock for the
 * duration of a 500-row apply would serialise every loop working the same job on the `jobs` row,
 * turning the whole point of SKIP LOCKED into a queue.
 */
export async function touchLastProgress(prisma: PrismaClient, jobId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE jobs SET last_progress_at = now() WHERE id = ${jobId}::uuid
  `;
}

/**
 * Penalises the items of a chunk whose apply failed.
 *
 * Runs in its own transaction after the chunk's rollback, and is guarded by `status = 'pending'`
 * so it cannot touch a row another loop has already resolved — without that guard, a retry-failed
 * replay or a concurrent success could be reverted to `pending` by a late failure record.
 *
 * The backoff is computed from the row's own `attempts`, in SQL, so two loops recording failures
 * for overlapping chunks cannot read the same value and both write the same next attempt.
 */
export async function recordChunkFailure(
  prisma: PrismaClient,
  jobId: string,
  opportunityIds: string[],
  error: string,
): Promise<void> {
  if (opportunityIds.length === 0) return;
  const maxAttempts = getConfig().maxAttempts;
  // Truncated: `last_error` is for a human reading the progress response, and a megabyte of
  // Postgres error detail per row would bloat the table without telling them more.
  const message = error.slice(0, 1000);

  await prisma.$executeRaw`
    UPDATE job_items
    SET attempts = attempts + 1,
        last_error = ${message},
        status = CASE
          WHEN attempts + 1 >= ${maxAttempts} THEN 'failed'::job_item_status
          ELSE 'pending'::job_item_status
        END,
        next_attempt_at = now() + (interval '1 second' * power(2, least(attempts, 10)))
    WHERE job_id = ${jobId}::uuid
      AND opportunity_id = ANY(${opportunityIds}::uuid[])
      AND status = 'pending'
  `;
}

/**
 * Finalizes every drained running job, in one statement.
 *
 * The status *decision* is folded into the same UPDATE as the emptiness check, which is the whole
 * point. Two races make anything less wrong:
 *
 *   - Reading `count(pending) = 0` and then updating lets `POST /jobs/:id/retry-failed` flip items
 *     back to `pending` in the gap; the job would be marked `completed` with real work sitting in
 *     it.
 *   - Folding in only the emptiness check but computing `completed` vs `failed` from an earlier
 *     read of the failed count lets `recordChunkFailure` mark the last item `failed` in the gap;
 *     the job would report `status: completed` alongside `failed: 1`, a direct contradiction.
 *
 * `FOR UPDATE SKIP LOCKED` on the candidate CTE closes a third race that folding alone does not.
 * Under READ COMMITTED, an UPDATE blocked on a row another transaction is writing re-evaluates its
 * WHERE clause against the *new* row version when it resumes — but the subqueries in that clause
 * still run against the statement's original snapshot. Measured: a writer holding the `jobs` row
 * while it inserts a `pending` item made the plain UPDATE resume, see `status = 'running'` on the
 * fresh tuple, miss the now-committed pending row, and mark the job `completed` — a claimable item
 * inside a job the picker will never look at again. Skipping locked candidates means the sweep
 * never resumes on a stale snapshot at all; the next sweep re-reads from scratch.
 *
 * This leaves one obligation on everything else: a writer that makes work claimable in a drained
 * job must touch that job's own row in the same transaction. `POST /jobs/:id/retry-failed` does,
 * by resetting `status` to `running` alongside the items. A bare `INSERT` of a pending item with no
 * `jobs` write cannot be serialised against the sweep by any means available here, because it is
 * invisible to a snapshot taken before it commits.
 *
 * The CASE literals are cast explicitly because a bare CASE over string literals resolves to
 * `text`, which will not assign to a `job_status` column.
 *
 * Returns the number of jobs finalized.
 */
export async function runFinalizeSweep(prisma: PrismaClient): Promise<number> {
  return prisma.$executeRaw`
    WITH candidates AS (
      SELECT j.id
      FROM jobs j
      WHERE j.status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM job_items ji WHERE ji.job_id = j.id AND ji.status = 'pending'
        )
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs SET
      status = CASE
        WHEN EXISTS (SELECT 1 FROM job_items WHERE job_id = jobs.id AND status = 'failed')
          THEN 'failed'::job_status
        ELSE 'completed'::job_status
      END,
      error_message = (
        SELECT count(*) || ' item(s) failed after max attempts; see job_items.last_error'
        FROM job_items WHERE job_id = jobs.id AND status = 'failed'
        HAVING count(*) > 0
      )
    WHERE id IN (SELECT id FROM candidates)
  `;
}
