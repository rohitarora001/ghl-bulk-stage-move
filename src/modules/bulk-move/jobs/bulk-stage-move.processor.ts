import { getConfig } from '@config';
import type { TickResult } from '@shared/worker-runtime';
import type { BulkMoveWorkerService } from '../bulk-move.worker.service';

/**
 * One turn of a claim loop: find a job, work one chunk of it, record that it moved.
 *
 * Thin on purpose. Every decision about *what* happens to the rows lives in the worker service;
 * what is here is only the retry cadence — how long to wait when there was nothing to do, and how
 * long after a claim-level failure.
 */
export function createBulkStageMoveProcessor(service: BulkMoveWorkerService) {
  return async function processOneChunk(): Promise<TickResult> {
    const config = getConfig();

    const jobId = await service.pickJob();
    if (jobId === null) return { sleepMs: config.idleBackoffMs };

    const result = await service.processChunk(jobId);

    if (result.outcome === 'claim-error') return { sleepMs: config.claimBackoffMs };
    if (result.outcome === 'applied' && result.claimedCount === 0) {
      // The picker saw claimable work and another loop took it first. Not an error, but there is
      // nothing to record and no point spinning.
      return { sleepMs: config.idleBackoffMs };
    }

    // Recorded for a committed chunk and for a failed one alike: `last_progress_at` orders the
    // picker, so leaving it untouched after a failure would make the loops keep returning to the
    // same poisoned job ahead of every other tenant's.
    await service.touchProgress(jobId);
    return { sleepMs: 0 };
  };
}
