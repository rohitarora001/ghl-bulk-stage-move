import type { JOB_CLASSIFICATION } from './bulk-move.constants';
import type { BulkMoveFilter } from './bulk-move.schemas';

export interface SubmitBulkMoveInput {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly filter: BulkMoveFilter;
  readonly targetStageId: string;
}

export interface SubmitBulkMoveResult {
  readonly jobId: string;
  readonly totalCount: number;
  /** Null when truncated: we deliberately never counted past the cap. */
  readonly matchedCount: number | null;
  readonly truncated: boolean;
  /** False for a replayed key — the caller gets 200 instead of 202. */
  readonly created: boolean;
}

export type JobClassification = (typeof JOB_CLASSIFICATION)[keyof typeof JOB_CLASSIFICATION];

export interface JobProgress {
  readonly id: string;
  readonly status: string;
  readonly totalCount: number;
  readonly matchedCount: number | null;
  readonly truncated: boolean;
  readonly counts: {
    readonly done: number;
    readonly pending: number;
    readonly skippedConflict: number;
    readonly failed: number;
  };
  readonly backedOff: number;
  readonly lastProgressAt: Date | null;
  readonly errorMessage: string | null;
  readonly classification: JobClassification;
}

/** The committed counts one query returns, before they are classified. */
export interface JobProgressCounts {
  readonly id: string;
  readonly status: string;
  readonly totalCount: number;
  readonly matchedCount: number | null;
  readonly truncated: boolean;
  readonly lastProgressAt: Date | null;
  readonly errorMessage: string | null;
  readonly done: number;
  readonly pending: number;
  readonly skippedConflict: number;
  readonly failed: number;
  readonly backedOff: number;
  /** True when nothing has touched this job for the staleness window. */
  readonly stale: boolean;
}

export interface RetryResult {
  readonly jobId: string;
  readonly retriedCount: number;
}

/** What a replayed `Idempotency-Key` finds. */
export interface ExistingJob {
  readonly id: string;
  readonly totalCount: number;
  readonly matchedCount: number | null;
  readonly truncated: boolean;
  readonly requestFingerprint: string | null;
}
