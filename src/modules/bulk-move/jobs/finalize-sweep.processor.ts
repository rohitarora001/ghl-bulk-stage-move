import { getConfig } from '@config';
import { logger } from '@shared/logger';
import type { TickResult } from '@shared/worker-runtime';
import type { BulkMoveWorkerService } from '../bulk-move.worker.service';

/**
 * One sweep: finalize every job whose items have all been resolved.
 *
 * It swallows its own failures rather than letting the loop's error path handle them, because a
 * failed sweep is not an incident: the jobs stay `running` and the next sweep finalizes them. The
 * distinction is worth keeping in the logs — `warn` here, `error` for anything the loop itself
 * could not absorb.
 */
export function createFinalizeSweepProcessor(service: BulkMoveWorkerService) {
  return async function sweepOnce(): Promise<TickResult> {
    try {
      const finalized = await service.finalizeDrainedJobs();
      if (finalized > 0) logger.info('jobs_finalized', { count: finalized });
    } catch (error) {
      logger.warn('sweep_error', { error: String(error) });
    }
    return { sleepMs: getConfig().sweepIntervalMs };
  };
}
