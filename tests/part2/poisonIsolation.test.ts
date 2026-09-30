import { claimAndApplyChunk } from '../../src/worker/claimAndApplyChunk';
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
 * One bad row must cost one row.
 *
 * The chunk is one transaction, so a single row that cannot be applied rolls back its 499
 * blameless chunkmates with it. Penalising the whole claimed set for that is what turns one
 * poisoned opportunity into a failed job: every chunkmate collects an attempt it did not earn,
 * and after `MAX_ATTEMPTS` passes the entire job is `failed` with nothing moved. The rollback is
 * unavoidable; charging the rollback to rows that would have committed is not.
 */

const CHUNK_SIZE = 4;

/**
 * A poison that is real rather than injected: a job-attributed transition already exists for this
 * opportunity, so the chunk's `INSERT INTO transitions` violates `transitions_job_opportunity_uq`
 * and Postgres aborts the transaction. This is the shape of the production failure — a constraint
 * the data cannot satisfy — and it is specific to one row, which is the point.
 */
async function poison(
  jobId: string,
  opportunityId: string,
  fixture: WorkspaceFixture,
  toStageId: string,
): Promise<void> {
  await adminPrisma.transition.create({
    data: {
      opportunityId,
      workspaceId: fixture.workspaceId,
      fromStageId: null,
      toStageId,
      jobId,
    },
  });
}

describe('a chunk with one poisoned row', () => {
  let fixture: WorkspaceFixture;
  const originalChunkSize = process.env.CHUNK_SIZE;

  beforeAll(() => {
    process.env.CHUNK_SIZE = String(CHUNK_SIZE);
    resetConfigCache();
  });

  afterAll(async () => {
    if (originalChunkSize === undefined) delete process.env.CHUNK_SIZE;
    else process.env.CHUNK_SIZE = originalChunkSize;
    resetConfigCache();
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  it('moves its chunkmates and penalises only the row that failed', async () => {
    const job = await enrollFreshOpportunities(fixture, CHUNK_SIZE);
    // The middle of the chunk, so the isolation pass has healthy rows both before and after it.
    const poisonedId = job.opportunityIds[1]!;
    const healthyIds = job.opportunityIds.filter((id) => id !== poisonedId);
    await poison(job.jobId, poisonedId, fixture, job.targetStageId);
    const before = new Date();

    await claimAndApplyChunk(adminPrisma, job.jobId);

    const healthy = await adminPrisma.opportunity.findMany({ where: { id: { in: healthyIds } } });
    expect(healthy).toHaveLength(CHUNK_SIZE - 1);
    // The blameless rows committed: the job did the work it was asked to do for them.
    expect(healthy.every((row) => row.stageId === job.targetStageId)).toBe(true);
    expect(healthy.every((row) => row.version === 2)).toBe(true);

    const poisoned = await adminPrisma.opportunity.findUniqueOrThrow({ where: { id: poisonedId } });
    expect(poisoned.stageId).not.toBe(job.targetStageId);
    expect(poisoned.version).toBe(1);

    const items = await adminPrisma.jobItem.findMany({ where: { jobId: job.jobId } });
    const byOpportunity = new Map(items.map((item) => [item.opportunityId, item]));

    for (const id of healthyIds) {
      const item = byOpportunity.get(id)!;
      expect(item.status).toBe('done');
      // No attempt charged, no backoff, no error text: nothing about this row failed.
      expect(item.attempts).toBe(0);
      expect(item.lastError).toBeNull();
    }

    const poisonedItem = byOpportunity.get(poisonedId)!;
    expect(poisonedItem.status).toBe('pending');
    expect(poisonedItem.attempts).toBe(1);
    expect(poisonedItem.lastError).not.toBeNull();
    expect(poisonedItem.nextAttemptAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('reports the failure to the caller, so the loop still records progress', async () => {
    const job = await enrollFreshOpportunities(fixture, CHUNK_SIZE);
    await poison(job.jobId, job.opportunityIds[1]!, fixture, job.targetStageId);

    const result = await claimAndApplyChunk(adminPrisma, job.jobId);

    // `apply-error` and not `applied`: something in this chunk genuinely did not apply, and a
    // caller told otherwise would treat a poisoned job as a healthy one.
    expect(result.outcome).toBe('apply-error');
    expect(result).toMatchObject({ claimedCount: CHUNK_SIZE });
  });
});
