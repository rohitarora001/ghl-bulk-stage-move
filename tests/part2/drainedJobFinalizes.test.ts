import { resetConfigCache } from '@config';
import { runLoop, runSweepLoop } from '../../src/worker/index';
import { runFinalizeSweep } from '../../src/worker/queries';
import { enrollFreshOpportunities } from '../setup/jobFixtures';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * A drained job must reach a terminal status because time passed, not because the worker happened
 * to run out of other work.
 *
 * Idle-gating the sweep — sweeping only when the picker returns nothing — looks equivalent and is
 * not: a busy tenant's 50 000-item job keeps every loop occupied for minutes, and a small job that
 * finished in the first second sits at `running` for the whole of it. The progress endpoint reads
 * committed state, so what the customer sees is a finished job that claims to still be working.
 */

const SWEEP_INTERVAL_MS = 100;
/** One item per chunk, so job B stays claimable for many iterations. */
const CHUNK_SIZE = 1;
const B_SIZE = 60;

const ENV: Record<string, string> = {
  SWEEP_INTERVAL_MS: String(SWEEP_INTERVAL_MS),
  CHUNK_SIZE: String(CHUNK_SIZE),
  IDLE_BACKOFF_MS: '10',
  CLAIM_BACKOFF_MS: '10',
};

async function statusOf(jobId: string): Promise<string> {
  const job = await adminPrisma.job.findUniqueOrThrow({ where: { id: jobId } });
  return job.status;
}

async function pendingCount(jobId: string): Promise<number> {
  return adminPrisma.jobItem.count({ where: { jobId, status: 'pending' } });
}

/** Polls committed state — the only place a caller can observe finalization. */
async function waitForStatus(jobId: string, want: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await statusOf(jobId)) === want) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return (await statusOf(jobId)) === want;
}

describe('a drained job', () => {
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

  it('is finalized as completed by the sweep alone, with no picker and no chunk', async () => {
    const job = await enrollFreshOpportunities(fixture, 3);
    await adminPrisma.jobItem.updateMany({ where: { jobId: job.jobId }, data: { status: 'done' } });

    const finalized = await runFinalizeSweep(adminPrisma);

    expect(finalized).toBe(1);
    expect(await statusOf(job.jobId)).toBe('completed');
    const finalJob = await adminPrisma.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(finalJob.errorMessage).toBeNull();
  });

  it('finalizes while every loop is still busy on another job', async () => {
    const drained = await enrollFreshOpportunities(fixture, 3);
    await adminPrisma.jobItem.updateMany({
      where: { jobId: drained.jobId },
      data: { status: 'done' },
    });
    // Enough work that B cannot possibly drain inside the deadline below: an idle-gated sweep
    // never gets its chance, and the assertion fails for the right reason.
    const busy = await enrollFreshOpportunities(fixture, B_SIZE, {
      sourceStageId: fixture.stageIds[2]!,
      targetStageId: fixture.stageIds[1]!,
    });

    const controller = new AbortController();
    const workers = [
      runLoop(1, controller.signal, adminPrisma),
      runLoop(2, controller.signal, adminPrisma),
      runSweepLoop(controller.signal, adminPrisma),
    ];

    try {
      const finalized = await waitForStatus(drained.jobId, 'completed', 2 * SWEEP_INTERVAL_MS);
      const stillBusy = await pendingCount(busy.jobId);

      expect(finalized).toBe(true);
      // Proves the loops were occupied, not idle, when the sweep ran.
      expect(stillBusy).toBeGreaterThan(0);
    } finally {
      controller.abort();
      await Promise.all(workers);
    }
  });
});
