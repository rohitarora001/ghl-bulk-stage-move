import { Prisma } from '@prisma/client';
import { interactivePrisma } from '../../db/prismaClients';
import { getConfig } from '../../shared/config';
import { ApiError } from '../errors';
import type { BulkMoveFilter } from '../schemas';

/**
 * Submission captures the guest list. Everything the job will ever touch is written into
 * `job_items` inside the same transaction that creates the `jobs` row, so a job that exists
 * always has its full set of work, and progress is computable from committed state alone.
 *
 * The filter is stored for display and debugging but is NEVER re-evaluated: re-running it later
 * would silently pick up rows created after submission and silently drop rows edited out of the
 * match set, making "how far along is this job?" unanswerable.
 */

export interface SubmitBulkMoveInput {
  workspaceId: string;
  idempotencyKey: string;
  filter: BulkMoveFilter;
  targetStageId: string;
}

export interface SubmitBulkMoveResult {
  jobId: string;
  totalCount: number;
  matchedCount: number | null;
  truncated: boolean;
  created: boolean;
}

/**
 * Turns the validated filter into SQL predicates.
 *
 * `workspace_id` leads, and `pipeline_id` is pinned to the target stage's pipeline: that single
 * clause is what makes the cross-pipeline rule true for a bulk move by construction, rather than
 * by a check that a later refactor could drop.
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

/**
 * Resolves the target stage and enforces both scope rules before any write happens.
 *
 * Workspace: a stage id leaked or guessed from another tenant would otherwise let this workspace
 * move its own opportunities into that tenant's pipeline.
 * Pipeline: a target stage in another pipeline of the same workspace passes the workspace check
 * but would leave `pipeline_id` and `stage_id` pointing at different pipelines.
 */
async function resolveTargetStage(
  workspaceId: string,
  targetStageId: string,
  filter: BulkMoveFilter,
): Promise<{ pipelineId: string }> {
  const target = await interactivePrisma.stage.findFirst({
    where: { id: targetStageId, workspaceId },
    select: { pipelineId: true },
  });
  if (!target) {
    throw ApiError.badRequest(
      'target_stage_invalid',
      'targetStageId does not name a stage in this workspace',
    );
  }

  if (filter.stageId) {
    const source = await interactivePrisma.stage.findFirst({
      where: { id: filter.stageId, workspaceId },
      select: { pipelineId: true },
    });
    if (!source) {
      throw ApiError.badRequest(
        'filter_stage_invalid',
        'filter.stageId does not name a stage in this workspace',
      );
    }
    if (source.pipelineId !== target.pipelineId) {
      throw ApiError.badRequest(
        'cross_pipeline_move',
        'targetStageId belongs to a different pipeline than filter.stageId',
      );
    }
  }

  return { pipelineId: target.pipelineId };
}

/** The reply for a key that has already been used: the caller gets the job they already have. */
async function replayExisting(
  workspaceId: string,
  idempotencyKey: string,
): Promise<SubmitBulkMoveResult | null> {
  const existing = await interactivePrisma.job.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    select: { id: true, totalCount: true, matchedCount: true, truncated: true },
  });
  if (!existing) return null;
  return {
    jobId: existing.id,
    totalCount: existing.totalCount,
    matchedCount: existing.matchedCount,
    truncated: existing.truncated,
    created: false,
  };
}

/** Postgres unique-violation SQLSTATE, as Prisma reports it for a raw statement or a model call. */
function isUniqueViolation(error: unknown): boolean {
  const known = error as { code?: string; meta?: { code?: string } };
  return known?.code === 'P2002' || known?.meta?.code === '23505';
}

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
 * and `value` are unselective here (~25% of the workspace), so a parallel sequential scan wins,
 * and the work is genuinely O(matches) rather than O(limit). Second, "memory-bounded" only holds
 * while the limit is small: at the real cap of 50 000 the sort is too big for work_mem and
 * spills to disk. A broad filter therefore pays a real, size-dependent cost on the submission
 * request thread. See DESIGN.md.
 */
function takeSnapshot(
  input: SubmitBulkMoveInput,
  where: Prisma.Sql,
  limit: number,
): Promise<SubmitBulkMoveResult> {
  const { workspaceId, idempotencyKey, filter, targetStageId } = input;
  return interactivePrisma.$transaction(async (tx) => {
    const [job] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO jobs (workspace_id, idempotency_key, filter, target_stage_id, total_count)
      VALUES (${workspaceId}::uuid, ${idempotencyKey}, ${filter as object}, ${targetStageId}::uuid, 0)
      RETURNING id
    `;
    const jobId = job!.id;

    // One round trip, and no opportunity id crosses the wire: selecting 50 000 ids into Node only
    // to send them straight back as an INSERT would double both the work and the latency.
    // `picked` takes one row more than the cap. That extra row is the whole truncation detector:
    // if it exists the filter matched more than we will enrol, and we know it without a second
    // unbounded `count(*)` over the match set — which is exactly the query the cap exists to
    // avoid running on a request thread.
    const [counts] = await tx.$queryRaw<{ inserted: bigint; probed: bigint }[]>`
      WITH picked AS (
        SELECT o.id, o.version, o.created_at
        FROM opportunities o
        WHERE ${where}
        ORDER BY o.created_at, o.id
        LIMIT ${limit + 1}
      ),
      ins AS (
        INSERT INTO job_items (job_id, opportunity_id, expected_version, status)
        SELECT ${jobId}::uuid, picked.id, picked.version, 'pending'::job_item_status
        FROM picked
        ORDER BY picked.created_at, picked.id
        LIMIT ${limit}
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM ins) AS inserted, (SELECT count(*) FROM picked) AS probed
    `;
    const totalCount = Number(counts!.inserted);
    const truncated = Number(counts!.probed) > limit;
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
}

export async function submitBulkMoveJob(input: SubmitBulkMoveInput): Promise<SubmitBulkMoveResult> {
  const { workspaceId, idempotencyKey, filter, targetStageId } = input;
  const limit = getConfig().bulkMaxItems;

  // Cheap path for the common retry. It is not the guarantee — the unique constraint is — but it
  // keeps a retried request from paying for a snapshot query it would then have to discard.
  const replay = await replayExisting(workspaceId, idempotencyKey);
  if (replay) return replay;

  const { pipelineId } = await resolveTargetStage(workspaceId, targetStageId, filter);
  const where = filterPredicates(workspaceId, pipelineId, filter);

  try {
    return await takeSnapshot(input, where, limit);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Two retries arrived together and both got past the pre-check. Postgres made the loser wait
    // on the winner's uncommitted row, so by the time 23505 comes back the winner is committed
    // and visible. The loser's own job insert — and with it its whole snapshot — rolled back.
    const winner = await replayExisting(workspaceId, idempotencyKey);
    if (!winner) throw error;
    return winner;
  }
}
