import { enrollFreshOpportunities } from '../setup/jobFixtures';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';
import { workerFor } from '../setup/workerFixtures';

/**
 * One chunk is one transaction. The claim and the apply cannot be split: releasing the row locks
 * between them would let a manual edit slip in after the version check passed, and the job would
 * then overwrite it while reporting success.
 */

describe('claimAndApplyChunk', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('moves every claimed opportunity and records exactly one transition each', async () => {
    const job = await enrollFreshOpportunities(fixture, 5);

    const result = await workerFor(adminPrisma).processChunk(job.jobId);

    expect(result).toMatchObject({
      outcome: 'applied',
      claimedCount: 5,
      doneCount: 5,
      conflictCount: 0,
    });

    const items = await adminPrisma.jobItem.findMany({ where: { jobId: job.jobId } });
    expect(items).toHaveLength(5);
    expect(items.every((item) => item.status === 'done')).toBe(true);

    const opportunities = await adminPrisma.opportunity.findMany({
      where: { id: { in: job.opportunityIds } },
    });
    expect(opportunities.every((row) => row.stageId === job.targetStageId)).toBe(true);
    // Bumped exactly once: a second bump would mean the row was written twice, and would make
    // every other job's frozen expected_version stale for no reason.
    expect(opportunities.every((row) => row.version === 2)).toBe(true);

    const transitions = await adminPrisma.transition.findMany({
      where: { jobId: job.jobId },
    });
    expect(transitions).toHaveLength(5);
    expect(transitions.every((row) => row.toStageId === job.targetStageId)).toBe(true);
    // from_stage_id comes from the locked read, not from a second lookup that could see a
    // different value than the one the move actually started from.
    expect(transitions.every((row) => row.fromStageId === fixture.stageIds[0])).toBe(true);
    expect(transitions.every((row) => row.workspaceId === fixture.workspaceId)).toBe(true);
    expect(new Set(transitions.map((row) => row.opportunityId)).size).toBe(5);
  });

  it('reports having claimed nothing when the job has no claimable items', async () => {
    const job = await enrollFreshOpportunities(fixture, 0);

    const result = await workerFor(adminPrisma).processChunk(job.jobId);

    expect(result).toMatchObject({ outcome: 'applied', claimedCount: 0 });
    expect(await adminPrisma.transition.count()).toBe(0);
  });

  it('advances the job through several chunks without ever redoing an item', async () => {
    const job = await enrollFreshOpportunities(fixture, 7);

    await workerFor(adminPrisma).processChunk(job.jobId);
    // The second call has nothing left to claim, because status IS the cursor.
    const second = await workerFor(adminPrisma).processChunk(job.jobId);

    expect(second).toMatchObject({ outcome: 'applied', claimedCount: 0 });
    // Still one transition per opportunity, not two: the second pass claimed nothing at all.
    expect(await adminPrisma.transition.count({ where: { jobId: job.jobId } })).toBe(7);
    const opportunities = await adminPrisma.opportunity.findMany({
      where: { id: { in: job.opportunityIds } },
    });
    expect(opportunities.every((row) => row.version === 2)).toBe(true);
  });
});
