import type { PrismaClient } from '@prisma/client';
import { getConfig } from '@config';
import { logger } from '@shared/logger';
import { recordChunkFailure } from './queries';

/**
 * One chunk, one transaction.
 *
 * The claim and the apply are deliberately NOT split. `FOR UPDATE SKIP LOCKED` only holds its
 * locks until the transaction ends, so committing after the claim and applying in a second
 * transaction would release every lock in between — a manual edit could land in that window,
 * after the version check passed and before the write, and the job would overwrite it while
 * reporting success. Splitting them would also manufacture false conflicts: the second
 * transaction re-reads a version its own first transaction has no claim on any more.
 */

export type ChunkResult =
  /** The claim itself failed. Nothing was claimed, so nothing is penalised. */
  | { outcome: 'claim-error'; error: string }
  | { outcome: 'applied'; claimedCount: number; doneCount: number; conflictCount: number }
  /** The apply failed after rows were claimed; `recordChunkFailure` has already run. */
  | { outcome: 'apply-error'; claimedCount: number; error: string };

interface ClaimedItem {
  id: bigint;
  opportunity_id: string;
  expected_version: number;
}

interface LockedOpportunity {
  id: string;
  stage_id: string;
  version: number;
}

export async function claimAndApplyChunk(
  prisma: PrismaClient,
  jobId: string,
  /**
   * How many items to claim. Defaults to the configured chunk size; the isolation pass below
   * passes 1, which is also what stops it recursing.
   */
  limit: number = getConfig().chunkSize,
): Promise<ChunkResult> {
  let claimedIds: string[] = [];

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const [job] = await tx.$queryRaw<{ target_stage_id: string; workspace_id: string }[]>`
          SELECT target_stage_id, workspace_id FROM jobs WHERE id = ${jobId}::uuid
        `;
        if (!job) return { outcome: 'applied', claimedCount: 0, doneCount: 0, conflictCount: 0 };

        // SKIP LOCKED is the whole concurrency primitive: several loops run this same statement
        // against the same job and each gets a disjoint set of rows, with no coordinator and no
        // waiting. `next_attempt_at` keeps backed-off poison rows out of the claim.
        const claimed = await tx.$queryRaw<ClaimedItem[]>`
          SELECT id, opportunity_id, expected_version
          FROM job_items
          WHERE job_id = ${jobId}::uuid
            AND status = 'pending'
            AND next_attempt_at <= now()
          ORDER BY id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `;
        if (claimed.length === 0) {
          return { outcome: 'applied', claimedCount: 0, doneCount: 0, conflictCount: 0 };
        }

        const opportunityIds = claimed.map((item) => item.opportunity_id);
        claimedIds = opportunityIds;

        // `ORDER BY id FOR UPDATE` — a deterministic lock order. Two loops holding locks on the
        // same two opportunities in opposite orders is precisely how a deadlock happens; sorting
        // by primary key makes that impossible rather than merely unlikely. This read is also
        // where `from_stage_id` comes from, so the transition records the stage the move actually
        // started from.
        const locked = await tx.$queryRaw<LockedOpportunity[]>`
          SELECT id, stage_id, version
          FROM opportunities
          WHERE id = ANY(${opportunityIds}::uuid[])
          ORDER BY id
          FOR UPDATE
        `;
        const byId = new Map(locked.map((row) => [row.id, row]));

        const applyItemIds: bigint[] = [];
        const applyOpportunityIds: string[] = [];
        const applyFromStages: string[] = [];
        const doneItemIds: bigint[] = [];
        const conflictItemIds: bigint[] = [];

        for (const item of claimed) {
          const row = byId.get(item.opportunity_id);
          if (!row) {
            // The opportunity was deleted after the snapshot. There is nothing to move and
            // nothing to conflict with, so the item is finished rather than retried forever.
            doneItemIds.push(item.id);
            continue;
          }
          if (row.stage_id === job.target_stage_id) {
            // Already at the target, whatever the version says: a no-op by definition. Excluded
            // from the mutation entirely — no UPDATE, no version bump, no transition — so a
            // replayed job does nothing at all to this row rather than writing a fake X → X
            // transition and invalidating every other job's frozen expected_version.
            doneItemIds.push(item.id);
            continue;
          }
          if (row.version !== item.expected_version) {
            // A human got there first. The manual edit wins; the job stands down and says so.
            conflictItemIds.push(item.id);
            continue;
          }
          applyItemIds.push(item.id);
          applyOpportunityIds.push(row.id);
          applyFromStages.push(row.stage_id);
        }

        if (applyOpportunityIds.length > 0) {
          // No version predicate: these rows are locked and their versions were just verified
          // against the same snapshot, inside this transaction.
          await tx.$executeRaw`
            UPDATE opportunities
            SET stage_id = ${job.target_stage_id}::uuid, version = version + 1, updated_at = now()
            WHERE id = ANY(${applyOpportunityIds}::uuid[])
          `;
          // One statement for the whole chunk's audit rows. The partial unique index on
          // (job_id, opportunity_id) makes a double-apply structurally impossible, not merely
          // detectable afterwards.
          await tx.$executeRaw`
            INSERT INTO transitions (opportunity_id, workspace_id, from_stage_id, to_stage_id, job_id)
            SELECT
              unnest(${applyOpportunityIds}::uuid[]),
              ${job.workspace_id}::uuid,
              unnest(${applyFromStages}::uuid[]),
              ${job.target_stage_id}::uuid,
              ${jobId}::uuid
          `;
        }

        const finishedItemIds = [...doneItemIds, ...applyItemIds];
        if (finishedItemIds.length > 0) {
          await tx.$executeRaw`
            UPDATE job_items SET status = 'done'
            WHERE id = ANY(${finishedItemIds}::bigint[])
          `;
        }
        if (conflictItemIds.length > 0) {
          await tx.$executeRaw`
            UPDATE job_items SET status = 'skipped_conflict'
            WHERE id = ANY(${conflictItemIds}::bigint[])
          `;
        }

        return {
          outcome: 'applied' as const,
          claimedCount: claimed.length,
          doneCount: finishedItemIds.length,
          conflictCount: conflictItemIds.length,
        };
      },
      {
        // Prisma's 5s/2s defaults are far too tight for a 500-row multi-statement transaction
        // under contention; hitting them would roll back a chunk that was making progress.
        timeout: 60_000,
        maxWait: 30_000,
      },
    );

    return result as ChunkResult;
  } catch (error) {
    const message = String(error);
    if (claimedIds.length === 0) {
      // Tier 1: the claim itself failed. Nothing was claimed, so there is nothing to penalise —
      // incrementing `attempts` here would punish rows for the worker's bad luck.
      logger.warn('chunk_claim_error', { jobId, error: message });
      return { outcome: 'claim-error', error: message };
    }
    // Tier 2: rows were claimed and the apply failed. The chunk transaction rolled back, so the
    // penalty is recorded in a fresh transaction of its own — recording it inside the failed one
    // would roll back with it and the poison chunk would retry at full speed forever.
    logger.warn('chunk_apply_error', { jobId, claimedCount: claimedIds.length, error: message });

    // Which of the claimed rows actually caused this is unknowable from the error: the chunk is
    // one transaction, so the rollback hits every row whether it was going to commit or not.
    // Charging them all for it is what turns one poisoned opportunity into a failed job — 499
    // blameless rows collect an attempt each and, after MAX_ATTEMPTS, the whole job is `failed`
    // with nothing moved. Re-run the same items one at a time instead, so each row is judged on
    // its own transaction and only the offender is penalised. The pass costs N round trips, but
    // it is only ever paid on a failure.
    if (claimedIds.length > 1) return isolateChunk(prisma, jobId, claimedIds.length, message);

    await recordChunkFailure(prisma, jobId, claimedIds, message);
    return { outcome: 'apply-error', claimedCount: claimedIds.length, error: message };
  }
}

/**
 * Re-applies a failed chunk's items one per transaction.
 *
 * Every call here claims with `limit = 1`, so each one takes the Tier 2 branch above with a single
 * claimed id and penalises only that row — which is also why this cannot recurse: a one-item chunk
 * never satisfies `claimedIds.length > 1`.
 *
 * It re-claims rather than being handed the ids: the failed items are `pending` again after the
 * rollback, and re-claiming keeps every row that passes through here going through the same
 * `FOR UPDATE SKIP LOCKED` path, so a row another loop picked up in the meantime is simply skipped
 * instead of being worked twice.
 */
async function isolateChunk(
  prisma: PrismaClient,
  jobId: string,
  attempts: number,
  chunkError: string,
): Promise<ChunkResult> {
  let claimedCount = 0;
  let doneCount = 0;
  let conflictCount = 0;
  let lastError: string | null = null;

  for (let index = 0; index < attempts; index += 1) {
    const result = await claimAndApplyChunk(prisma, jobId, 1);
    if (result.outcome === 'claim-error') {
      lastError = result.error;
      break;
    }
    claimedCount += result.claimedCount;
    if (result.outcome === 'apply-error') {
      lastError = result.error;
      continue;
    }
    // Nothing left that this loop can claim: the rest of the chunk was backed off by a failure
    // above, or another loop took it. Either way there is no more work to isolate.
    if (result.claimedCount === 0) break;
    doneCount += result.doneCount;
    conflictCount += result.conflictCount;
  }

  if (lastError !== null) {
    return { outcome: 'apply-error', claimedCount, error: lastError };
  }
  // Every item applied on its own: the chunk failed for something transient — a deadlock, a lost
  // connection — rather than for its contents.
  logger.info('chunk_isolation_recovered', { jobId, claimedCount, error: chunkError });
  return { outcome: 'applied', claimedCount, doneCount, conflictCount };
}
