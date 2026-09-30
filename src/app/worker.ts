import type { PrismaClient } from '@prisma/client';
import { getConfig } from '@config';
import { createJobRegistry, JOB_KIND } from '@jobs/registry';
import { createBulkMoveWorkerRepository } from '@modules/bulk-move/bulk-move.worker.repository';
import { createBulkMoveWorkerService } from '@modules/bulk-move/bulk-move.worker.service';
import { disconnectAll, jobPrisma, sweepPrisma } from '@shared/database';
import { logger } from '@shared/logger';
import { runPollingLoop } from '@shared/worker-runtime';

/**
 * The worker: `workerPoolSize` identical loops, no coordinator.
 *
 * Nothing assigns work to a loop. Each one picks a job, claims a chunk with SKIP LOCKED, and the
 * database decides who gets which rows. That is why the pool can be scaled, killed, or restarted
 * without any handover protocol: a loop's only state is the transaction it is inside, and a
 * transaction that dies rolls back.
 */

/** Builds the worker-side wiring over a given client. Exported so tests can drive a real loop. */
export function createWorkerRegistry(prisma: PrismaClient) {
  return createJobRegistry({
    bulkMoveWorkerService: createBulkMoveWorkerService(createBulkMoveWorkerRepository(prisma)),
  });
}

/**
 * One claim loop. Returns when `signal` aborts, never on its own.
 *
 * `prisma` is injectable so tests can drive a real loop against their own client; production
 * always uses the capped worker pool.
 */
export async function runLoop(
  loopId: number,
  signal: AbortSignal,
  prisma: PrismaClient = jobPrisma,
): Promise<void> {
  const registry = createWorkerRegistry(prisma);
  await runPollingLoop({
    name: 'loop',
    signal,
    context: { loopId },
    tick: registry[JOB_KIND.BULK_STAGE_MOVE],
    errorBackoffMs: getConfig().claimBackoffMs,
  });
}

/**
 * The finalize sweeper: one per process, on its own clock and its own connection.
 *
 * Time-driven, and deliberately neither idle-gated nor loop-gated.
 *
 * Idle-gating — sweeping only when the picker returns nothing — would leave a small job that
 * drained in the first second at `running` for as long as some other tenant's 50 000-item job
 * keeps the pool busy, and the progress endpoint reports committed state, so that customer is told
 * their finished job is still working.
 *
 * Running it at the top of a claim loop has the same failure in a narrower window: a chunk may
 * hold its transaction for up to 60s, and while every loop is inside one, nothing reaches the top
 * of a loop body. Hence a loop of its own — and `sweepPrisma`, whose single connection is held by
 * nothing else, so the sweeper never queues behind the chunks it is meant to report on.
 */
export async function runSweepLoop(
  signal: AbortSignal,
  prisma: PrismaClient = sweepPrisma,
): Promise<void> {
  const registry = createWorkerRegistry(prisma);
  await runPollingLoop({
    name: 'sweeper',
    signal,
    tick: registry[JOB_KIND.FINALIZE_SWEEP],
    errorBackoffMs: getConfig().sweepIntervalMs,
  });
}

export async function startWorker(): Promise<void> {
  const config = getConfig();
  const controller = new AbortController();

  /**
   * Graceful stop: abort, then let every loop finish the chunk it is inside. A killed loop is also
   * safe — the transaction rolls back and the items return to `pending` — but a clean stop keeps
   * the work it already did.
   */
  function shutdown(signal: string): void {
    logger.info('worker_shutdown', { signal });
    controller.abort();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('worker_started', { loops: config.workerPoolSize });
  const workers = Array.from({ length: config.workerPoolSize }, (_, index) =>
    runLoop(index + 1, controller.signal),
  );
  workers.push(runSweepLoop(controller.signal));
  await Promise.all(workers);
  await disconnectAll();
  logger.info('worker_stopped', {});
}

if (require.main === module) {
  void startWorker().catch((error) => {
    logger.error('worker_crashed', { error: String(error) });
    process.exit(1);
  });
}
