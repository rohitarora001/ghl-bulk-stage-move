import { Prisma, type PrismaClient } from '@prisma/client';
import { hasPostgresCode, hasPrismaCode, PG_ERROR, PRISMA_ERROR } from '@shared/database';
import type { BulkMoveFilter } from './bulk-move.schemas';
import type { ExistingJob, JobProgressCounts, SubmitBulkMoveResult } from './bulk-move.types';

interface ProgressRow {
  id: string;
  status: string;
  total_count: number;
  matched_count: number | null;
  truncated: boolean;
  last_progress_at: Date | null;
  error_message: string | null;
  done: bigint;
  pending: bigint;
  skipped_conflict: bigint;
  failed: bigint;
  backed_off: bigint;
  stale: boolean;
}

/**
 * Turns the validated filter into SQL predicates.
 *
 * `workspace_id` leads, and `pipeline_id` is pinned to the target stage's pipeline: that single
 * clause is what makes the cross-pipeline rule true for a bulk move by construction, rather than
 * by a check a later refactor could drop.
 */
function filterPredicates(
  workspaceId: string,
  pipelineId: string,
  filter: BulkMoveFilter,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`o.workspace_id = ${workspaceId}::uuid`,
    Prisma.sql`o.pipeline_id = ${pipelineId}::uuid`,
  ];
  if (filter.stageId) clauses.push(Prisma.sql`o.stage_id = ${filter.stageId}::uuid`);
  if (filter.ownerId) clauses.push(Prisma.sql`o.owner_id = ${filter.ownerId}::uuid`);
  if (filter.status) clauses.push(Prisma.sql`o.status = ${filter.status}::opportunity_status`);
  if (filter.valueMin !== undefined) clauses.push(Prisma.sql`o.value >= ${filter.valueMin}`);
  if (filter.valueMax !== undefined) clauses.push(Prisma.sql`o.value <= ${filter.valueMax}`);
  if (filter.createdFrom) clauses.push(Prisma.sql`o.created_at >= ${new Date(filter.createdFrom)}`);
  if (filter.createdTo) clauses.push(Prisma.sql`o.created_at <= ${new Date(filter.createdTo)}`);
  return Prisma.join(clauses, ' AND ');
}

export interface SnapshotArgs {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly filter: BulkMoveFilter;
  readonly targetStageId: string;
  readonly pipelineId: string;
  readonly fingerprint: string;
  readonly limit: number;
}

export interface BulkMoveRepository {
  findStagePipeline(workspaceId: string, stageId: string): Promise<string | null>;
  findJobByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<ExistingJob | null>;
  createJobWithSnapshot(args: SnapshotArgs): Promise<SubmitBulkMoveResult>;
  findProgress(
    workspaceId: string,
    jobId: string,
    stuckAfterMs: number,
  ): Promise<JobProgressCounts | null>;
  retryFailedItems(workspaceId: string, jobId: string): Promise<number | null>;
  isUniqueViolation(error: unknown): boolean;
}

/** Every statement the bulk-move feature runs against Postgres. */
export function createBulkMoveRepository(prisma: PrismaClient): BulkMoveRepository {
  return {
    async findStagePipeline(workspaceId, stageId) {
      const stage = await prisma.stage.findFirst({
        where: { id: stageId, workspaceId },
        select: { pipelineId: true },
      });
      return stage?.pipelineId ?? null;
    },

    async findJobByIdempotencyKey(workspaceId, idempotencyKey) {
      return prisma.job.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
        select: {
          id: true,
          totalCount: true,
          matchedCount: true,
          truncated: true,
          requestFingerprint: true,
        },
      });
    },

    /**
     * Creates the job and its snapshot in one transaction, so a job row never exists without the
     * full set of work it was created to do.
     *
     * Measured plans, `EXPLAIN ANALYZE` against a seeded 500 000-row workspace (Postgres 16,
     * default `work_mem`), for the `picked` subquery — the expensive half of the statement:
     *
     *   (a) stage-only filter, LIMIT 50 001:
     *       Limit → Index Scan using idx_opportunities_stage_list
     *         Index Cond: (workspace_id, stage_id); no sort node at all.
     *       120 ms for 50 001 rows; at LIMIT 501, 3 ms. Cost tracks the limit, not the match size,
     *       because the index already yields (created_at, id) order.
     *
     *   (b) status + valueMin, no stage narrowing, LIMIT 50 001:
     *       Limit → Gather Merge → Sort → Parallel Seq Scan
     *         Sort Method: external merge, Disk: 3016 kB
     *         Rows Removed by Filter: 130 659
     *       81 ms. At LIMIT 501 the same shape but Sort Method: top-N heapsort, Memory: 85 kB.
     *
     * Two things worth stating plainly, because both are narrower than the tidy version of this
     * claim. First, the planner did not choose idx_opportunities_filter for (b) at all: `status`
     * and `value` are unselective here (~25% of the workspace), so a parallel sequential scan
     * wins, and the work is genuinely O(matches) rather than O(limit). Second, "memory-bounded"
     * only holds while the limit is small: at the real cap of 50 000 the sort is too big for
     * work_mem and spills to disk. A broad filter therefore pays a real, size-dependent cost on
     * the submission request thread. See DESIGN.md.
     */
    async createJobWithSnapshot(args) {
      const where = filterPredicates(args.workspaceId, args.pipelineId, args.filter);

      return prisma.$transaction(async (tx) => {
        const [job] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO jobs (workspace_id, idempotency_key, request_fingerprint, filter, target_stage_id, total_count)
          VALUES (${args.workspaceId}::uuid, ${args.idempotencyKey}, ${args.fingerprint},
                  ${args.filter as object}, ${args.targetStageId}::uuid, 0)
          RETURNING id
        `;
        const jobId = job!.id;

        // One round trip, and no opportunity id crosses the wire: selecting 50 000 ids into Node
        // only to send them straight back as an INSERT would double both the work and the latency.
        // `picked` takes one row more than the cap. That extra row is the whole truncation
        // detector: if it exists the filter matched more than we will enrol, and we know it
        // without a second unbounded `count(*)` over the match set — which is exactly the query
        // the cap exists to avoid running on a request thread.
        const [counts] = await tx.$queryRaw<{ inserted: bigint; probed: bigint }[]>`
          WITH picked AS (
            SELECT o.id, o.version, o.created_at
            FROM opportunities o
            WHERE ${where}
            ORDER BY o.created_at, o.id
            LIMIT ${args.limit + 1}
          ),
          ins AS (
            INSERT INTO job_items (job_id, opportunity_id, expected_version, status)
            SELECT ${jobId}::uuid, picked.id, picked.version, 'pending'::job_item_status
            FROM picked
            ORDER BY picked.created_at, picked.id
            LIMIT ${args.limit}
            RETURNING 1
          )
          SELECT (SELECT count(*) FROM ins) AS inserted, (SELECT count(*) FROM picked) AS probed
        `;
        const totalCount = Number(counts!.inserted);
        const truncated = Number(counts!.probed) > args.limit;
        // Null rather than a number the caller might mistake for the real total: we deliberately
        // never counted past the cap, so the honest answer to "how many matched?" is "unknown".
        const matchedCount = truncated ? null : totalCount;

        await tx.$executeRaw`
          UPDATE jobs
          SET total_count = ${totalCount}, matched_count = ${matchedCount}, truncated = ${truncated}
          WHERE id = ${jobId}::uuid
        `;

        return { jobId, totalCount, matchedCount, truncated, created: true };
      });
    },

    /**
     * Progress in one statement.
     *
     * LEFT JOIN, not an inner one: a job whose items are all gone (or a zero-match job) must still
     * answer with zeroes rather than 404. One query so the four numbers a caller compares against
     * each other come from a single snapshot rather than from four reads a concurrent chunk could
     * land between.
     */
    async findProgress(workspaceId, jobId, stuckAfterMs) {
      const [row] = await prisma.$queryRaw<ProgressRow[]>`
        SELECT
          j.id,
          j.status::text AS status,
          j.total_count,
          j.matched_count,
          j.truncated,
          j.last_progress_at,
          j.error_message,
          count(ji.id) FILTER (WHERE ji.status = 'done') AS done,
          count(ji.id) FILTER (WHERE ji.status = 'pending') AS pending,
          count(ji.id) FILTER (WHERE ji.status = 'skipped_conflict') AS skipped_conflict,
          count(ji.id) FILTER (WHERE ji.status = 'failed') AS failed,
          count(ji.id) FILTER (WHERE ji.status = 'pending' AND ji.next_attempt_at > now())
            AS backed_off,
          -- created_at as the fallback: a job that has never made progress is not automatically
          -- fresh, it is as old as its submission.
          coalesce(j.last_progress_at, j.created_at)
            < now() - (interval '1 millisecond' * ${stuckAfterMs}) AS stale
        FROM jobs j
        LEFT JOIN job_items ji ON ji.job_id = j.id
        WHERE j.id = ${jobId}::uuid AND j.workspace_id = ${workspaceId}::uuid
        GROUP BY j.id
      `;
      if (!row) return null;

      return {
        id: row.id,
        status: row.status,
        totalCount: row.total_count,
        matchedCount: row.matched_count,
        truncated: row.truncated,
        lastProgressAt: row.last_progress_at,
        errorMessage: row.error_message,
        done: Number(row.done),
        pending: Number(row.pending),
        skippedConflict: Number(row.skipped_conflict),
        failed: Number(row.failed),
        backedOff: Number(row.backed_off),
        stale: row.stale,
      };
    },

    /**
     * Puts a job's exhausted items back in the queue. Returns null when there is no such job.
     *
     * `expected_version` is deliberately left exactly as the snapshot froze it: an item that
     * failed for an unrelated reason and has since been edited by a human must come back as a
     * conflict, not as an overwrite. Refreshing it here would turn an operator's "try that batch
     * again" into a silent revert of someone else's work.
     */
    async retryFailedItems(workspaceId, jobId) {
      return prisma.$transaction(async (tx) => {
        // Locked, and locked first. The finalize sweep skips jobs whose row is locked, so holding
        // it here is what stops the sweep from re-finalizing this job on a snapshot taken before
        // the items became pending again — see the note on runFinalizeSweep.
        const [job] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM jobs WHERE id = ${jobId}::uuid AND workspace_id = ${workspaceId}::uuid
          FOR UPDATE
        `;
        if (!job) return null;

        const retriedCount = await tx.$executeRaw`
          UPDATE job_items
          SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
          WHERE job_id = ${jobId}::uuid AND status = 'failed'
        `;

        if (retriedCount > 0) {
          // Same transaction as the items, never a follow-up statement: a job left 'failed' with
          // pending items is invisible to the picker, and the work would sit there forever.
          await tx.$executeRaw`
            UPDATE jobs SET status = 'running', error_message = NULL, last_progress_at = now()
            WHERE id = ${jobId}::uuid
          `;
        }

        // Nothing failed ⇒ nothing to do. Deliberately NOT flipping a completed job back to
        // running: a second call must not un-finish a job that finished.
        return retriedCount;
      });
    },

    isUniqueViolation(error) {
      return (
        hasPrismaCode(error, PRISMA_ERROR.UNIQUE_CONSTRAINT) ||
        hasPostgresCode(error, PG_ERROR.UNIQUE_VIOLATION)
      );
    },
  };
}
