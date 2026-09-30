import type { PrismaClient } from '@prisma/client';
import { getConfig } from '@config';
import type { DbClient } from '@shared/database';

/**
 * The worker's statements, separate from the API's for two reasons that matter.
 *
 * They run as a different Postgres role through a different pool — `app_worker`, capped at
 * `connection_limit`, which is the isolation mechanism — and they are the only statements in the
 * system whose transaction boundaries are load-bearing for correctness rather than for tidiness.
 *
 * All of them are set-based and single-statement on purpose. A read followed by a write is a race
 * whenever anything else can touch the same rows, and in this system something always can: another
 * loop, the finalize sweep, or an operator calling retry-failed.
 */

export interface ClaimedItem {
  readonly id: bigint;
  readonly opportunityId: string;
  readonly expectedVersion: number;
}

export interface LockedOpportunityRow {
  readonly id: string;
  readonly stageId: string;
  readonly version: number;
}

export interface JobTarget {
  readonly targetStageId: string;
  readonly workspaceId: string;
}

export interface BulkMoveWorkerRepository {
  runChunkTransaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T>;
  findJobTarget(tx: DbClient, jobId: string): Promise<JobTarget | null>;
  claimPendingItems(tx: DbClient, jobId: string, limit: number): Promise<ClaimedItem[]>;
  lockOpportunities(tx: DbClient, opportunityIds: string[]): Promise<LockedOpportunityRow[]>;
  applyMoves(
    tx: DbClient,
    args: {
      opportunityIds: string[];
      fromStageIds: string[];
      toStageId: string;
      workspaceId: string;
      jobId: string;
    },
  ): Promise<void>;
  markItems(tx: DbClient, itemIds: bigint[], status: 'done' | 'skipped_conflict'): Promise<void>;
  pickJobWithClaimableWork(): Promise<string | null>;
  touchLastProgress(jobId: string): Promise<void>;
  recordChunkFailure(jobId: string, opportunityIds: string[], error: string): Promise<void>;
  runFinalizeSweep(): Promise<number>;
}

/** How long a chunk transaction may run, and how long it may wait for a connection. */
const CHUNK_TRANSACTION_OPTIONS = {
  // Prisma's 5s/2s defaults are far too tight for a 500-row multi-statement transaction under
  // contention; hitting them would roll back a chunk that was making progress.
  timeout: 60_000,
  maxWait: 30_000,
};

/** `last_error` is for a human reading the progress response, so it is truncated. */
const MAX_ERROR_LENGTH = 1000;

export function createBulkMoveWorkerRepository(prisma: PrismaClient): BulkMoveWorkerRepository {
  return {
    async runChunkTransaction(work) {
      return prisma.$transaction(work, CHUNK_TRANSACTION_OPTIONS);
    },

    async findJobTarget(tx, jobId) {
      const [job] = await tx.$queryRaw<{ target_stage_id: string; workspace_id: string }[]>`
        SELECT target_stage_id, workspace_id FROM jobs WHERE id = ${jobId}::uuid
      `;
      if (!job) return null;
      return { targetStageId: job.target_stage_id, workspaceId: job.workspace_id };
    },

    /**
     * SKIP LOCKED is the whole concurrency primitive: several loops run this same statement
     * against the same job and each gets a disjoint set of rows, with no coordinator and no
     * waiting. `next_attempt_at` keeps backed-off poison rows out of the claim.
     */
    async claimPendingItems(tx, jobId, limit) {
      const rows = await tx.$queryRaw<
        { id: bigint; opportunity_id: string; expected_version: number }[]
      >`
        SELECT id, opportunity_id, expected_version
        FROM job_items
        WHERE job_id = ${jobId}::uuid
          AND status = 'pending'
          AND next_attempt_at <= now()
        ORDER BY id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
      return rows.map((row) => ({
        id: row.id,
        opportunityId: row.opportunity_id,
        expectedVersion: row.expected_version,
      }));
    },

    /**
     * `ORDER BY id FOR UPDATE` — a deterministic lock order. Two loops holding locks on the same
     * two opportunities in opposite orders is precisely how a deadlock happens; sorting by primary
     * key makes that impossible rather than merely unlikely. This read is also where
     * `from_stage_id` comes from, so the transition records the stage the move actually started
     * from.
     */
    async lockOpportunities(tx, opportunityIds) {
      const rows = await tx.$queryRaw<{ id: string; stage_id: string; version: number }[]>`
        SELECT id, stage_id, version
        FROM opportunities
        WHERE id = ANY(${opportunityIds}::uuid[])
        ORDER BY id
        FOR UPDATE
      `;
      return rows.map((row) => ({ id: row.id, stageId: row.stage_id, version: row.version }));
    },

    async applyMoves(tx, { opportunityIds, fromStageIds, toStageId, workspaceId, jobId }) {
      // No version predicate: these rows are locked and their versions were just verified against
      // the same snapshot, inside this transaction.
      await tx.$executeRaw`
        UPDATE opportunities
        SET stage_id = ${toStageId}::uuid, version = version + 1, updated_at = now()
        WHERE id = ANY(${opportunityIds}::uuid[])
      `;
      // One statement for the whole chunk's audit rows. The partial unique index on
      // (job_id, opportunity_id) makes a double-apply structurally impossible, not merely
      // detectable afterwards.
      await tx.$executeRaw`
        INSERT INTO transitions (opportunity_id, workspace_id, from_stage_id, to_stage_id, job_id)
        SELECT
          unnest(${opportunityIds}::uuid[]),
          ${workspaceId}::uuid,
          unnest(${fromStageIds}::uuid[]),
          ${toStageId}::uuid,
          ${jobId}::uuid
      `;
    },

    async markItems(tx, itemIds, status) {
      if (itemIds.length === 0) return;
      if (status === 'done') {
        await tx.$executeRaw`
          UPDATE job_items SET status = 'done' WHERE id = ANY(${itemIds}::bigint[])
        `;
        return;
      }
      await tx.$executeRaw`
        UPDATE job_items SET status = 'skipped_conflict' WHERE id = ANY(${itemIds}::bigint[])
      `;
    },

    /**
     * The next job worth working on.
     *
     * `EXISTS (... claimable ...)` is the important half. Scoping only to `status = 'running'`
     * would keep handing back a job whose every remaining item is backed off into the future; the
     * loop would claim nothing, and — because the picker is ordered by progress — would be handed
     * the same useless job again, starving jobs that do have work. Ordering by `last_progress_at
     * ASC NULLS FIRST` puts brand-new jobs at the front and rotates between jobs that are all
     * making progress.
     */
    async pickJobWithClaimableWork() {
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
    },

    /**
     * Records that a chunk committed.
     *
     * Runs AFTER the chunk transaction commits, never inside it: holding this row's lock for the
     * duration of a 500-row apply would serialise every loop working the same job on the `jobs`
     * row, turning the whole point of SKIP LOCKED into a queue.
     */
    async touchLastProgress(jobId) {
      await prisma.$executeRaw`
        UPDATE jobs SET last_progress_at = now() WHERE id = ${jobId}::uuid
      `;
    },

    /**
     * Penalises the items of a chunk whose apply failed.
     *
     * Runs in its own transaction after the chunk's rollback, and is guarded by
     * `status = 'pending'` so it cannot touch a row another loop has already resolved — without
     * that guard, a retry-failed replay or a concurrent success could be reverted to `pending` by
     * a late failure record.
     *
     * The backoff is computed from the row's own `attempts`, in SQL, so two loops recording
     * failures for overlapping chunks cannot read the same value and both write the same next
     * attempt.
     */
    async recordChunkFailure(jobId, opportunityIds, error) {
      if (opportunityIds.length === 0) return;
      const maxAttempts = getConfig().maxAttempts;
      const message = error.slice(0, MAX_ERROR_LENGTH);

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
    },

    /**
     * Finalizes every drained running job, in one statement.
     *
     * The status *decision* is folded into the same UPDATE as the emptiness check, which is the
     * whole point. Two races make anything less wrong:
     *
     *   - Reading `count(pending) = 0` and then updating lets `POST /jobs/:id/retry-failed` flip
     *     items back to `pending` in the gap; the job would be marked `completed` with real work
     *     sitting in it.
     *   - Folding in only the emptiness check but computing `completed` vs `failed` from an
     *     earlier read of the failed count lets `recordChunkFailure` mark the last item `failed`
     *     in the gap; the job would report `status: completed` alongside `failed: 1`, a direct
     *     contradiction.
     *
     * `FOR UPDATE SKIP LOCKED` on the candidate CTE closes a third race that folding alone does
     * not. Under READ COMMITTED, an UPDATE blocked on a row another transaction is writing
     * re-evaluates its WHERE clause against the *new* row version when it resumes — but the
     * subqueries in that clause still run against the statement's original snapshot. Measured: a
     * writer holding the `jobs` row while it inserts a `pending` item made the plain UPDATE
     * resume, see `status = 'running'` on the fresh tuple, miss the now-committed pending row, and
     * mark the job `completed` — a claimable item inside a job the picker will never look at
     * again. Skipping locked candidates means the sweep never resumes on a stale snapshot at all;
     * the next sweep re-reads from scratch.
     *
     * This leaves one obligation on everything else: a writer that makes work claimable in a
     * drained job must touch that job's own row in the same transaction. `POST
     * /jobs/:id/retry-failed` does, by resetting `status` to `running` alongside the items. A bare
     * `INSERT` of a pending item with no `jobs` write cannot be serialised against the sweep by
     * any means available here, because it is invisible to a snapshot taken before it commits.
     *
     * The CASE literals are cast explicitly because a bare CASE over string literals resolves to
     * `text`, which will not assign to a `job_status` column.
     */
    async runFinalizeSweep() {
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
    },
  };
}
