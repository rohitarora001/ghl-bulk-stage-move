import type { Prisma, PrismaClient } from '@prisma/client';
import { claimAndApplyChunk } from '../../src/worker/claimAndApplyChunk';
import { runFinalizeSweep } from '../../src/worker/queries';
import { resetConfigCache } from '../../src/shared/config';
import { enrollFreshOpportunities } from '../setup/jobFixtures';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * A chunk that fails for a reason no retry will fix — a bad target, a constraint the data cannot
 * satisfy — must not spin the worker at full speed forever. Attempts are counted, the next try is
 * pushed further out each time, and past the limit the items are `failed` and left alone so the
 * rest of the job can finish.
 */

const MAX_ATTEMPTS = 3;

/**
 * Wraps a client so that the apply's `UPDATE opportunities` rejects, while the claim and
 * everything else runs for real. Only the one statement under test is faked: the claim must
 * really claim, and the rollback must really roll back, or the test proves nothing about
 * recovery.
 */
function withFailingApply(real: PrismaClient): PrismaClient {
  const wrapTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(target, property, receiver) {
        if (property === '$executeRaw') {
          return (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (strings.join(' ').includes('UPDATE opportunities')) {
              throw new Error('injected apply failure');
            }
            return (target.$executeRaw as (...args: unknown[]) => unknown)(strings, ...values);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return (fn: (tx: Prisma.TransactionClient) => unknown, options?: unknown) =>
          (real.$transaction as (...args: unknown[]) => unknown)(
            (tx: Prisma.TransactionClient) => fn(wrapTx(tx)),
            options,
          );
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PrismaClient;
}

/** Backoff would otherwise make the test wait seconds between attempts. */
async function clearBackoff(jobId: string): Promise<void> {
  await adminPrisma.$executeRaw`
    UPDATE job_items SET next_attempt_at = now() WHERE job_id = ${jobId}::uuid AND status = 'pending'
  `;
}

describe('a chunk that keeps failing', () => {
  let fixture: WorkspaceFixture;
  const originalMax = process.env.MAX_ATTEMPTS;

  beforeAll(() => {
    process.env.MAX_ATTEMPTS = String(MAX_ATTEMPTS);
    resetConfigCache();
  });

  afterAll(async () => {
    if (originalMax === undefined) delete process.env.MAX_ATTEMPTS;
    else process.env.MAX_ATTEMPTS = originalMax;
    resetConfigCache();
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  it('counts the attempt, backs the items off, and leaves them claimable', async () => {
    const job = await enrollFreshOpportunities(fixture, 2);
    const before = new Date();

    const result = await claimAndApplyChunk(withFailingApply(adminPrisma), job.jobId);

    expect(result).toMatchObject({ outcome: 'apply-error', claimedCount: 2 });

    const items = await adminPrisma.jobItem.findMany({ where: { jobId: job.jobId } });
    expect(items.every((item) => item.attempts === 1)).toBe(true);
    // Still pending: one failure is not evidence the work is impossible.
    expect(items.every((item) => item.status === 'pending')).toBe(true);
    expect(items.every((item) => item.lastError !== null)).toBe(true);
    // Pushed into the future, so the next loop iteration does not immediately re-poison itself.
    expect(items.every((item) => item.nextAttemptAt > before)).toBe(true);

    // The transaction rolled back: nothing moved, nothing was audited.
    const opportunities = await adminPrisma.opportunity.findMany({
      where: { id: { in: job.opportunityIds } },
    });
    expect(opportunities.every((row) => row.version === 1)).toBe(true);
    expect(await adminPrisma.transition.count()).toBe(0);
  });

  it('gives up past the attempt limit and stops reclaiming the items', async () => {
    const job = await enrollFreshOpportunities(fixture, 2);
    const failing = withFailingApply(adminPrisma);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await clearBackoff(job.jobId);
      const result = await claimAndApplyChunk(failing, job.jobId);
      expect(result.outcome).toBe('apply-error');
    }

    const items = await adminPrisma.jobItem.findMany({ where: { jobId: job.jobId } });
    expect(items.every((item) => item.status === 'failed')).toBe(true);
    expect(items.every((item) => item.attempts === MAX_ATTEMPTS)).toBe(true);
    expect(items.every((item) => item.lastError?.includes('injected apply failure'))).toBe(true);

    // A healthy worker must not pick these up again, backoff cleared or not: `failed` is terminal
    // until an operator replays it.
    await clearBackoff(job.jobId);
    const healthy = await claimAndApplyChunk(adminPrisma, job.jobId);
    expect(healthy).toMatchObject({ outcome: 'applied', claimedCount: 0 });
  });

  it('finalizes the job as failed while the items that succeeded stay done', async () => {
    const job = await enrollFreshOpportunities(fixture, 4);
    // Resolve two items normally by taking them out of the poisoned chunk's reach first.
    const [firstItem, secondItem] = await adminPrisma.jobItem.findMany({
      where: { jobId: job.jobId },
      orderBy: { id: 'asc' },
      take: 2,
    });
    await adminPrisma.jobItem.updateMany({
      where: { id: { in: [firstItem!.id, secondItem!.id] } },
      data: { status: 'done' },
    });

    const failing = withFailingApply(adminPrisma);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await clearBackoff(job.jobId);
      await claimAndApplyChunk(failing, job.jobId);
    }

    await runFinalizeSweep(adminPrisma);

    const finalJob = await adminPrisma.job.findUniqueOrThrow({ where: { id: job.jobId } });
    // `failed`, not `completed`: reporting completion for a job that dropped work on the floor is
    // exactly the silent data loss the design forbids.
    expect(finalJob.status).toBe('failed');
    expect(finalJob.errorMessage).toContain('2');
    expect(finalJob.errorMessage).toContain('job_items.last_error');

    const counts = await adminPrisma.jobItem.groupBy({
      by: ['status'],
      where: { jobId: job.jobId },
      _count: { _all: true },
    });
    const byStatus = new Map(counts.map((row) => [row.status, row._count._all]));
    expect(byStatus.get('done')).toBe(2);
    expect(byStatus.get('failed')).toBe(2);
  });
});
