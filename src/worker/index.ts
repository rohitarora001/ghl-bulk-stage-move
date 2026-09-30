import type { PrismaClient } from '@prisma/client';
import { disconnectAll, jobPrisma, sweepPrisma } from '../db/prismaClients';
import { getConfig } from '../shared/config';
import { logger } from '../shared/logger';
import { claimAndApplyChunk } from './claimAndApplyChunk';
import { pickJobWithClaimableWork, runFinalizeSweep, touchLastProgress } from './queries';

/**
 * The worker: `workerPoolSize` identical loops, no coordinator.
 *
 * Nothing assigns work to a loop. Each one picks a job, claims a chunk with SKIP LOCKED, and the
 * database decides who gets which rows. That is why the pool can be scaled, killed, or restarted
 * without any handover protocol: a loop's only state is the transaction it is inside, and a
 * transaction that dies rolls back.
 */

/**
 * Abort-aware sleep. A plain `setTimeout` would make SIGTERM wait out the full backoff before the
 * loop noticed it, which is the difference between a container stopping and a container being
 * killed.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * The finalize sweeper: one per process, on its own clock and its own connection.
 *
 * Time-driven, and deliberately neither idle-gated nor loop-gated.
 *
 * Idle-gating — sweeping only when the picker returns nothing — would leave a small job that
 * drained in the first second at `running` for as long as some other tenant's 50 000-item job
 * keeps the pool busy, and the progress endpoint reports committed state, so that customer is
 * told their finished job is still working.
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
  const config = getConfig();
  logger.info('sweeper_started', {});

  while (!signal.aborted) {
    try {
      const finalized = await runFinalizeSweep(prisma);
      if (finalized > 0) logger.info('jobs_finalized', { count: finalized });
    } catch (error) {
      // A failed sweep is not fatal: the jobs stay `running` and the next sweep finalizes them.
      logger.warn('sweep_error', { error: String(error) });
    }
    await sleep(config.sweepIntervalMs, signal);
  }

  logger.info('sweeper_stopped', {});
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
  const config = getConfig();
  logger.info('loop_started', { loopId });

  while (!signal.aborted) {
    try {
      const jobId = await pickJobWithClaimableWork(prisma);
      if (jobId === null) {
        await sleep(config.idleBackoffMs, signal);
        continue;
      }

      const result = await claimAndApplyChunk(prisma, jobId);

      if (result.outcome === 'claim-error') {
        await sleep(config.claimBackoffMs, signal);
        continue;
      }
      if (result.outcome === 'applied' && result.claimedCount === 0) {
        // The picker saw claimable work and another loop took it first. Not an error, but there is
        // nothing to record and no point spinning.
        await sleep(config.idleBackoffMs, signal);
        continue;
      }
      // Recorded for a committed chunk and for a failed one alike: `last_progress_at` orders the
      // picker, so leaving it untouched after a failure would make the loops keep returning to the
      // same poisoned job ahead of every other tenant's.
      await touchLastProgress(prisma, jobId);
    } catch (error) {
      // Nothing inside the loop body is allowed to end the loop. A dropped connection or a
      // picker-level failure is transient; a loop that exits on it silently shrinks the pool.
      logger.error('loop_error', { loopId, error: String(error) });
      await sleep(config.claimBackoffMs, signal);
    }
  }

  logger.info('loop_stopped', { loopId });
}

export async function startWorker(): Promise<void> {
  const config = getConfig();
  const controller = new AbortController();

  /**
   * Graceful stop: abort, then let every loop finish the chunk it is inside. A killed loop is
   * also safe — the transaction rolls back and the items return to `pending` — but a clean stop
   * keeps the work it already did.
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
