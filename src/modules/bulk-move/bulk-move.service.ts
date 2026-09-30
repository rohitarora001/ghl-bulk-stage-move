import { getConfig } from '@config';
import { fingerprint } from '@shared/utils/fingerprint';
import { JOB_CLASSIFICATION, JOB_STATUS } from './bulk-move.constants';
import {
  CrossPipelineMoveError,
  FilterStageInvalidError,
  IdempotencyKeyConflictError,
  JobNotFoundError,
  TargetStageInvalidError,
} from './bulk-move.errors';
import type { BulkMoveRepository } from './bulk-move.repository';
import type { BulkMoveFilter } from './bulk-move.schemas';
import type {
  JobClassification,
  JobProgress,
  JobProgressCounts,
  RetryResult,
  SubmitBulkMoveInput,
  SubmitBulkMoveResult,
} from './bulk-move.types';

/**
 * The three-way classification the design doc calls for, and the reason `backedOff` exists.
 *
 * A stalled `last_progress_at` on its own is ambiguous: it looks identical whether every remaining
 * item is waiting out its own exponential backoff — expected, self-healing, resolves inside the
 * backoff window — or the worker is dead. `backedOff` separates them. `backing_off` is reported
 * regardless of freshness, because when nothing is claimable no worker can be failing to claim it.
 */
function classify(counts: JobProgressCounts): JobClassification {
  if (counts.status === JOB_STATUS.COMPLETED) return JOB_CLASSIFICATION.COMPLETED;
  if (counts.status === JOB_STATUS.FAILED) return JOB_CLASSIFICATION.FAILED;

  if (counts.pending === 0) return JOB_CLASSIFICATION.RUNNING;
  if (counts.backedOff === counts.pending) return JOB_CLASSIFICATION.BACKING_OFF;
  // Claimable work exists and nothing has touched this job for the staleness window: a human
  // needs to look at the worker, and saying so is the entire point of the endpoint.
  return counts.stale ? JOB_CLASSIFICATION.STUCK : JOB_CLASSIFICATION.RUNNING;
}

export interface BulkMoveService {
  submitBulkMoveJob(input: SubmitBulkMoveInput): Promise<SubmitBulkMoveResult>;
  getJobProgress(workspaceId: string, jobId: string): Promise<JobProgress>;
  retryFailedItems(workspaceId: string, jobId: string): Promise<RetryResult>;
}

/**
 * Submission captures the guest list. Everything the job will ever touch is written into
 * `job_items` inside the same transaction that creates the `jobs` row, so a job that exists always
 * has its full set of work, and progress is computable from committed state alone.
 *
 * The filter is stored for display and debugging but is NEVER re-evaluated: re-running it later
 * would silently pick up rows created after submission and silently drop rows edited out of the
 * match set, making "how far along is this job?" unanswerable.
 */
export function createBulkMoveService(repository: BulkMoveRepository): BulkMoveService {
  /**
   * Resolves the target stage and enforces both scope rules before any write happens.
   *
   * Workspace: a stage id leaked or guessed from another tenant would otherwise let this workspace
   * move its own opportunities into that tenant's pipeline.
   * Pipeline: a target stage in another pipeline of the same workspace passes the workspace check
   * but would leave `pipeline_id` and `stage_id` pointing at different pipelines.
   */
  async function resolveTargetPipeline(
    workspaceId: string,
    targetStageId: string,
    filter: BulkMoveFilter,
  ): Promise<string> {
    const targetPipelineId = await repository.findStagePipeline(workspaceId, targetStageId);
    if (targetPipelineId === null) throw new TargetStageInvalidError();

    if (filter.stageId) {
      const sourcePipelineId = await repository.findStagePipeline(workspaceId, filter.stageId);
      if (sourcePipelineId === null) throw new FilterStageInvalidError();
      if (sourcePipelineId !== targetPipelineId) throw new CrossPipelineMoveError();
    }

    return targetPipelineId;
  }

  /**
   * The reply for a key that has already been used: the caller gets the job they already have —
   * but only if they asked for the same thing.
   *
   * @throws {IdempotencyKeyConflictError} when the stored fingerprint names a different request.
   */
  async function replayExisting(
    workspaceId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<SubmitBulkMoveResult | null> {
    const existing = await repository.findJobByIdempotencyKey(workspaceId, idempotencyKey);
    if (!existing) return null;

    // A null stored fingerprint predates the column; there is nothing to compare, so the old
    // replay behaviour stands rather than turning historical jobs into 409s.
    if (
      existing.requestFingerprint !== null &&
      existing.requestFingerprint !== requestFingerprint
    ) {
      throw new IdempotencyKeyConflictError();
    }

    return {
      jobId: existing.id,
      totalCount: existing.totalCount,
      matchedCount: existing.matchedCount,
      truncated: existing.truncated,
      created: false,
    };
  }

  return {
    /**
     * Enrols the match set and returns the job.
     *
     * @throws {TargetStageInvalidError} {FilterStageInvalidError} {CrossPipelineMoveError}
     * @throws {IdempotencyKeyConflictError} when the key was used for a different request.
     */
    async submitBulkMoveJob(input) {
      const { workspaceId, idempotencyKey, filter, targetStageId } = input;
      const limit = getConfig().bulkMaxItems;
      const requestFingerprint = fingerprint({ filter, targetStageId });

      // Cheap path for the common retry. It is not the guarantee — the unique constraint is — but
      // it keeps a retried request from paying for a snapshot query it would then discard.
      const replay = await replayExisting(workspaceId, idempotencyKey, requestFingerprint);
      if (replay) return replay;

      const pipelineId = await resolveTargetPipeline(workspaceId, targetStageId, filter);

      try {
        return await repository.createJobWithSnapshot({
          workspaceId,
          idempotencyKey,
          filter,
          targetStageId,
          pipelineId,
          fingerprint: requestFingerprint,
          limit,
        });
      } catch (error) {
        if (!repository.isUniqueViolation(error)) throw error;
        // Two retries arrived together and both got past the pre-check. Postgres made the loser
        // wait on the winner's uncommitted row, so by the time 23505 comes back the winner is
        // committed and visible. The loser's own job insert — and with it its whole snapshot —
        // rolled back.
        const winner = await replayExisting(workspaceId, idempotencyKey, requestFingerprint);
        if (!winner) throw error;
        return winner;
      }
    },

    /**
     * Progress, computed from committed rows on every call.
     *
     * Nothing here reads a counter the worker keeps: a restart would lose it, a second worker
     * would never see it, and a caller could not tell either failure from real progress.
     *
     * @throws {JobNotFoundError} when no such job exists in this workspace.
     */
    async getJobProgress(workspaceId, jobId) {
      const counts = await repository.findProgress(workspaceId, jobId, getConfig().stuckAfterMs);
      if (!counts) throw new JobNotFoundError();

      return {
        id: counts.id,
        status: counts.status,
        totalCount: counts.totalCount,
        matchedCount: counts.matchedCount,
        truncated: counts.truncated,
        counts: {
          done: counts.done,
          pending: counts.pending,
          skippedConflict: counts.skippedConflict,
          failed: counts.failed,
        },
        backedOff: counts.backedOff,
        lastProgressAt: counts.lastProgressAt,
        errorMessage: counts.errorMessage,
        classification: classify(counts),
      };
    },

    /**
     * Re-enqueues every item that exhausted its retries. Naturally idempotent: a second call finds
     * nothing failed and flips nothing.
     *
     * @throws {JobNotFoundError} when no such job exists in this workspace.
     */
    async retryFailedItems(workspaceId, jobId) {
      const retriedCount = await repository.retryFailedItems(workspaceId, jobId);
      if (retriedCount === null) throw new JobNotFoundError();
      return { jobId, retriedCount };
    },
  };
}
