import { resetConfigCache } from '@config';
import { runFinalizeSweep, recordChunkFailure } from '../../src/worker/queries';
import { enrollFreshOpportunities } from '../setup/jobFixtures';
import {
  adminPrisma,
  createOpportunity,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * The sweep decides two things — whether a job is drained, and whether it drained clean — and both
 * have to be decided by the same statement that writes the answer.
 *
 * Read-then-write loses either way. Read `pending = 0` and then update, and a retry or a late
 * failure landing in the gap marks a job `completed` with real work still in it. Fold in the
 * emptiness check but compute `completed` vs `failed` from an earlier read, and the job reports
 * `completed` next to a non-zero failed count — a response that contradicts itself.
 *
 * The interleaving is produced by real concurrency over separate connections, repeated: a
 * read-then-write implementation has a full round trip between its read and its write, and a
 * statement issued at the same instant lands inside it. One round is luck; ten is not.
 */

const ROUNDS = 10;

describe('the finalize sweep racing a concurrent writer', () => {
  let fixture: WorkspaceFixture;
  const originalMax = process.env.MAX_ATTEMPTS;

  beforeAll(() => {
    // One strike: `recordChunkFailure` marks the item terminally `failed` on its first call.
    process.env.MAX_ATTEMPTS = '1';
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

  it('never completes a job whose pending item was committed first, even under lock contention', async () => {
    const job = await enrollFreshOpportunities(fixture, 2);
    await adminPrisma.jobItem.updateMany({ where: { jobId: job.jobId }, data: { status: 'done' } });
    const late = await createOpportunity(fixture, { stageId: fixture.stageIds[0]! });

    // The writer holds the `jobs` row lock while it adds claimable work, so the sweep is forced to
    // block mid-statement and then resume — the exact window a read-then-write implementation
    // reads its emptiness check in, and the one Postgres re-evaluates the WHERE clause in.
    let releaseWriter!: () => void;
    const writerMayCommit = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerHasLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      writerHasLock = resolve;
    });

    const writer = adminPrisma.$transaction(async (tx) => {
      // A retry-failed style arrival reconciles the job's own status in the same transaction that
      // makes the work claimable; that is what makes the pair safe in either order.
      await tx.$executeRaw`UPDATE jobs SET status = 'running' WHERE id = ${job.jobId}::uuid`;
      await tx.$executeRaw`
        INSERT INTO job_items (job_id, opportunity_id, expected_version, status)
        VALUES (${job.jobId}::uuid, ${late.id}::uuid, ${late.version}, 'pending')
      `;
      writerHasLock();
      await writerMayCommit;
    });

    await lockHeld;
    const sweep = runFinalizeSweep(adminPrisma);
    // Long enough for the sweep's statement to have reached the lock and be waiting on it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseWriter();
    await writer;
    await sweep;

    const finalJob = await adminPrisma.job.findUniqueOrThrow({ where: { id: job.jobId } });
    const pending = await adminPrisma.jobItem.count({
      where: { jobId: job.jobId, status: 'pending' },
    });
    expect(pending).toBe(1);
    // `completed` here would be committed data loss: a claimable item inside a job nothing will
    // ever pick up again.
    expect(finalJob.status).toBe('running');
  });

  it('never completes a job whose last item just failed', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const job = await enrollFreshOpportunities(fixture, 2);
      const [first] = await adminPrisma.jobItem.findMany({
        where: { jobId: job.jobId },
        orderBy: { id: 'asc' },
        take: 1,
      });
      await adminPrisma.jobItem.update({ where: { id: first!.id }, data: { status: 'done' } });
      const lastOpportunityId = job.opportunityIds.find((id) => id !== first!.opportunityId)!;

      await Promise.all([
        runFinalizeSweep(adminPrisma),
        recordChunkFailure(adminPrisma, job.jobId, [lastOpportunityId], 'injected failure'),
      ]);

      const finalJob = await adminPrisma.job.findUniqueOrThrow({ where: { id: job.jobId } });
      const failed = await adminPrisma.jobItem.count({
        where: { jobId: job.jobId, status: 'failed' },
      });

      // `completed` alongside a failed item is a self-contradicting response, whichever order won.
      expect({ round, contradiction: finalJob.status === 'completed' && failed > 0 }).toEqual({
        round,
        contradiction: false,
      });
      if (finalJob.status === 'failed') expect(finalJob.errorMessage).not.toBeNull();
    }
  });
});
