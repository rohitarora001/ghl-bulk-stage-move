import { getConfig } from '@config';
import { logger } from '@shared/logger';
import type { BulkMoveWorkerRepository } from './bulk-move.worker.repository';

/**
 * One chunk, one transaction.
 *
 * The claim and the apply are deliberately NOT split. `FOR UPDATE SKIP LOCKED` only holds its
 * locks until the transaction ends, so committing after the claim and applying in a second
 * transaction would release every lock in between — a manual edit could land in that window, after
 * the version check passed and before the write, and the job would overwrite it while reporting
 * success. Splitting them would also manufacture false conflicts: the second transaction re-reads
 * a version its own first transaction has no claim on any more.
 */

export type ChunkResult =
  /** The claim itself failed. Nothing was claimed, so nothing is penalised. */
  | { outcome: 'claim-error'; error: string }
  | { outcome: 'applied'; claimedCount: number; doneCount: number; conflictCount: number }
  /** The apply failed after rows were claimed; the failure has already been recorded. */
  | { outcome: 'apply-error'; claimedCount: number; error: string };

export interface BulkMoveWorkerService {
  /**
   * Claims up to `limit` items of a job and applies them in one transaction.
   *
   * @param limit defaults to the configured chunk size; the isolation pass passes 1, which is
   * also what stops it recursing.
   */
  processChunk(jobId: string, limit?: number): Promise<ChunkResult>;
  pickJob(): Promise<string | null>;
  touchProgress(jobId: string): Promise<void>;
  recordChunkFailure(jobId: string, opportunityIds: string[], error: string): Promise<void>;
  finalizeDrainedJobs(): Promise<number>;
}

export function createBulkMoveWorkerService(
  repository: BulkMoveWorkerRepository,
): BulkMoveWorkerService {
  /**
   * Re-applies a failed chunk's items one per transaction.
   *
   * Every call here claims with `limit = 1`, so each one penalises only that row — which is also
   * why this cannot recurse: a one-item chunk never satisfies `claimedIds.length > 1`.
   *
   * It re-claims rather than being handed the ids: the failed items are `pending` again after the
   * rollback, and re-claiming keeps every row going through the same `FOR UPDATE SKIP LOCKED`
   * path, so a row another loop picked up in the meantime is simply skipped instead of being
   * worked twice.
   */
  async function isolateChunk(
    jobId: string,
    attempts: number,
    chunkError: string,
  ): Promise<ChunkResult> {
    let claimedCount = 0;
    let doneCount = 0;
    let conflictCount = 0;
    let lastError: string | null = null;

    for (let index = 0; index < attempts; index += 1) {
      const result = await service.processChunk(jobId, 1);
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

  const service: BulkMoveWorkerService = {
    async processChunk(jobId, limit = getConfig().chunkSize) {
      let claimedIds: string[] = [];

      try {
        return await repository.runChunkTransaction(async (tx): Promise<ChunkResult> => {
          const job = await repository.findJobTarget(tx, jobId);
          if (!job) return { outcome: 'applied', claimedCount: 0, doneCount: 0, conflictCount: 0 };

          const claimed = await repository.claimPendingItems(tx, jobId, limit);
          if (claimed.length === 0) {
            return { outcome: 'applied', claimedCount: 0, doneCount: 0, conflictCount: 0 };
          }

          const opportunityIds = claimed.map((item) => item.opportunityId);
          claimedIds = opportunityIds;

          const locked = await repository.lockOpportunities(tx, opportunityIds);
          const byId = new Map(locked.map((row) => [row.id, row]));

          const applyItemIds: bigint[] = [];
          const applyOpportunityIds: string[] = [];
          const applyFromStages: string[] = [];
          const doneItemIds: bigint[] = [];
          const conflictItemIds: bigint[] = [];

          for (const item of claimed) {
            const row = byId.get(item.opportunityId);
            if (!row) {
              // The opportunity was deleted after the snapshot. There is nothing to move and
              // nothing to conflict with, so the item is finished rather than retried forever.
              doneItemIds.push(item.id);
              continue;
            }
            if (row.stageId === job.targetStageId) {
              // Already at the target, whatever the version says: a no-op by definition. Excluded
              // from the mutation entirely — no UPDATE, no version bump, no transition — so a
              // replayed job does nothing at all to this row rather than writing a fake X → X
              // transition and invalidating every other job's frozen expected_version.
              doneItemIds.push(item.id);
              continue;
            }
            if (row.version !== item.expectedVersion) {
              // A human got there first. The manual edit wins; the job stands down and says so.
              conflictItemIds.push(item.id);
              continue;
            }
            applyItemIds.push(item.id);
            applyOpportunityIds.push(row.id);
            applyFromStages.push(row.stageId);
          }

          if (applyOpportunityIds.length > 0) {
            await repository.applyMoves(tx, {
              opportunityIds: applyOpportunityIds,
              fromStageIds: applyFromStages,
              toStageId: job.targetStageId,
              workspaceId: job.workspaceId,
              jobId,
            });
          }

          const finishedItemIds = [...doneItemIds, ...applyItemIds];
          await repository.markItems(tx, finishedItemIds, 'done');
          await repository.markItems(tx, conflictItemIds, 'skipped_conflict');

          return {
            outcome: 'applied',
            claimedCount: claimed.length,
            doneCount: finishedItemIds.length,
            conflictCount: conflictItemIds.length,
          };
        });
      } catch (error) {
        const message = String(error);
        if (claimedIds.length === 0) {
          // Tier 1: the claim itself failed. Nothing was claimed, so there is nothing to penalise
          // — incrementing `attempts` here would punish rows for the worker's bad luck.
          logger.warn('chunk_claim_error', { jobId, error: message });
          return { outcome: 'claim-error', error: message };
        }
        // Tier 2: rows were claimed and the apply failed. The chunk transaction rolled back, so
        // the penalty is recorded in a fresh transaction of its own — recording it inside the
        // failed one would roll back with it and the poison chunk would retry at full speed
        // forever.
        logger.warn('chunk_apply_error', {
          jobId,
          claimedCount: claimedIds.length,
          error: message,
        });

        // Which of the claimed rows actually caused this is unknowable from the error: the chunk
        // is one transaction, so the rollback hits every row whether it was going to commit or
        // not. Charging them all for it is what turns one poisoned opportunity into a failed job —
        // 499 blameless rows collect an attempt each and, after MAX_ATTEMPTS, the whole job is
        // `failed` with nothing moved. Re-run the same items one at a time instead, so each row is
        // judged on its own transaction and only the offender is penalised. The pass costs N round
        // trips, but it is only ever paid on a failure.
        if (claimedIds.length > 1) return isolateChunk(jobId, claimedIds.length, message);

        await repository.recordChunkFailure(jobId, claimedIds, message);
        return { outcome: 'apply-error', claimedCount: claimedIds.length, error: message };
      }
    },

    pickJob: () => repository.pickJobWithClaimableWork(),

    touchProgress: (jobId) => repository.touchLastProgress(jobId),

    recordChunkFailure: (jobId, opportunityIds, error) =>
      repository.recordChunkFailure(jobId, opportunityIds, error),

    finalizeDrainedJobs: () => repository.runFinalizeSweep(),
  };

  return service;
}
