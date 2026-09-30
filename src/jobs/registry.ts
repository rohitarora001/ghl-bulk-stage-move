import type { BulkMoveWorkerService } from '@modules/bulk-move/bulk-move.worker.service';
import { createBulkStageMoveProcessor } from '@modules/bulk-move/jobs/bulk-stage-move.processor';
import { createFinalizeSweepProcessor } from '@modules/bulk-move/jobs/finalize-sweep.processor';
import type { TickResult } from '@shared/worker-runtime';

/**
 * Every kind of background work this system runs, in one place.
 *
 * There is no queue broker here: the queue is the `job_items` table and `status` is the cursor. A
 * "job kind" is therefore a processor that knows how to find its own work, not a message type —
 * and the registry's job is to make the full list of them readable without opening the worker
 * entrypoint.
 *
 * Two entries today. It is kept as a map rather than two imports because the next kind — a
 * retention sweep, a cancellation reaper — should be one line here and nothing else.
 */
export const JOB_KIND = {
  BULK_STAGE_MOVE: 'bulk-stage-move',
  FINALIZE_SWEEP: 'finalize-sweep',
} as const;

export type JobKind = (typeof JOB_KIND)[keyof typeof JOB_KIND];

export type JobProcessor = () => Promise<TickResult>;

export interface JobRegistryDependencies {
  readonly bulkMoveWorkerService: BulkMoveWorkerService;
}

export function createJobRegistry({
  bulkMoveWorkerService,
}: JobRegistryDependencies): Record<JobKind, JobProcessor> {
  return {
    [JOB_KIND.BULK_STAGE_MOVE]: createBulkStageMoveProcessor(bulkMoveWorkerService),
    [JOB_KIND.FINALIZE_SWEEP]: createFinalizeSweepProcessor(bulkMoveWorkerService),
  };
}
