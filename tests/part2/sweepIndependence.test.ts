import type { Prisma, PrismaClient } from '@prisma/client';
import { resetConfigCache } from '@config';
import { runLoop, runSweepLoop } from '../../src/worker/index';
import { enrollFreshOpportunities } from '../setup/jobFixtures';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * The sweep must not wait on a loop.
 *
 * `drainedJobFinalizes` proves the sweep is not idle-gated — it runs while the loops are busy with
 * other work. That proof holds only because those loops keep reaching the top of their iteration
 * between chunks. A chunk is allowed to take a minute (the transaction timeout is 60s), and while
 * every loop is inside one, a sweep that lives at the top of the loop body cannot run at all: a job
 * that drained a second ago keeps reporting `running` to its customer for as long as the longest
 * chunk in the pool takes. The sweep therefore runs on its own clock, on its own connection.
 */

const SWEEP_INTERVAL_MS = 50;

const ENV: Record<string, string> = {
  SWEEP_INTERVAL_MS: String(SWEEP_INTERVAL_MS),
  IDLE_BACKOFF_MS: '10',
  CLAIM_BACKOFF_MS: '10',
};

/**
 * A client whose chunk transaction does not return until the worker is asked to stop — a chunk
 * mid-flight, held exactly as long as the test needs it. Everything else (the picker's reads) runs
 * for real, so the loop genuinely picks a job and genuinely blocks applying it.
 */
function withHangingChunk(
  real: PrismaClient,
  signal: AbortSignal,
  onEnter: () => void,
): PrismaClient {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return (_fn: (tx: Prisma.TransactionClient) => unknown) =>
          new Promise((resolve) => {
            onEnter();
            const done = (): void =>
              resolve({ outcome: 'applied', claimedCount: 0, doneCount: 0, conflictCount: 0 });
            if (signal.aborted) done();
            else signal.addEventListener('abort', done, { once: true });
          });
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PrismaClient;
}

async function statusOf(jobId: string): Promise<string> {
  const job = await adminPrisma.job.findUniqueOrThrow({ where: { id: jobId } });
  return job.status;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

describe('the finalize sweep', () => {
  let fixture: WorkspaceFixture;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(ENV)) {
      original[key] = process.env[key];
      process.env[key] = value;
    }
    resetConfigCache();
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  it('finalizes a drained job while every loop is stuck inside a chunk', async () => {
    const busy = await enrollFreshOpportunities(fixture, 5);
    const draining = await enrollFreshOpportunities(fixture, 3, {
      sourceStageId: fixture.stageIds[2]!,
      targetStageId: fixture.stageIds[1]!,
    });

    const controller = new AbortController();
    let entered = false;
    const hanging = withHangingChunk(adminPrisma, controller.signal, () => {
      entered = true;
    });

    const workers = [
      runLoop(1, controller.signal, hanging),
      runSweepLoop(controller.signal, adminPrisma),
    ];

    try {
      // The loop is now inside a chunk and will not leave it until the test aborts.
      expect(await waitFor(async () => entered, 2000)).toBe(true);
      expect(await statusOf(busy.jobId)).toBe('running');

      // Only now does the other job drain, so no sweep that ran before the loop blocked can be
      // what finalizes it.
      await adminPrisma.jobItem.updateMany({
        where: { jobId: draining.jobId },
        data: { status: 'done' },
      });

      const finalized = await waitFor(
        async () => (await statusOf(draining.jobId)) === 'completed',
        20 * SWEEP_INTERVAL_MS,
      );
      expect(finalized).toBe(true);
      // The loop never came back: this was the sweeper's own clock, not a loop iteration.
      expect(await statusOf(busy.jobId)).toBe('running');
    } finally {
      controller.abort();
      await Promise.all(workers);
    }
  });
});
