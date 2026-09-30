import { resetConfigCache } from '@config';
import { claimAndApplyChunk } from '../../src/worker/claimAndApplyChunk';
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
 * `job_items.status` IS the cursor. There is no separate persisted offset to go stale, so a worker
 * that dies mid-job resumes by doing exactly what it always does: claim whatever is still
 * `pending`. This test kills a job halfway on purpose and then proves the two things a resumable
 * pipeline must guarantee — nothing is applied twice, and nothing is dropped.
 */

const CHUNK_SIZE = 4;
const TOTAL = 14; // ≥ 3 chunks, with a short final one.

describe('resuming a partially drained job', () => {
  let fixture: WorkspaceFixture;
  const originalChunk = process.env.CHUNK_SIZE;

  beforeAll(() => {
    process.env.CHUNK_SIZE = String(CHUNK_SIZE);
    resetConfigCache();
  });

  afterAll(async () => {
    if (originalChunk === undefined) delete process.env.CHUNK_SIZE;
    else process.env.CHUNK_SIZE = originalChunk;
    resetConfigCache();
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  it('picks up exactly where it stopped and applies every item exactly once', async () => {
    const job = await enrollFreshOpportunities(fixture, TOTAL);

    // Two chunks, then the process "dies".
    await claimAndApplyChunk(adminPrisma, job.jobId);
    await claimAndApplyChunk(adminPrisma, job.jobId);

    const midway = await adminPrisma.jobItem.groupBy({
      by: ['status'],
      where: { jobId: job.jobId },
      _count: { _all: true },
    });
    const midwayByStatus = new Map(midway.map((row) => [row.status, row._count._all]));
    expect(midwayByStatus.get('done')).toBe(2 * CHUNK_SIZE);
    expect(midwayByStatus.get('pending')).toBe(TOTAL - 2 * CHUNK_SIZE);
    // Still running: a half-drained job must not look finished to anyone reading committed state.
    const midJob = await adminPrisma.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(midJob.status).toBe('running');

    // A fresh worker starts with no memory of the dead one and drains the rest.
    let guard = 0;
    for (;;) {
      const result = await claimAndApplyChunk(adminPrisma, job.jobId);
      expect(result.outcome).toBe('applied');
      if (result.outcome === 'applied' && result.claimedCount === 0) break;
      guard += 1;
      expect(guard).toBeLessThan(10);
    }

    const items = await adminPrisma.jobItem.findMany({ where: { jobId: job.jobId } });
    expect(items).toHaveLength(TOTAL);
    expect(items.every((item) => item.status === 'done')).toBe(true);
    // No item was ever retried, so the kill cost nothing but the chunk in flight.
    expect(items.every((item) => item.attempts === 0)).toBe(true);

    const opportunities = await adminPrisma.opportunity.findMany({
      where: { id: { in: job.opportunityIds } },
    });
    expect(opportunities).toHaveLength(TOTAL);
    expect(opportunities.every((row) => row.stageId === job.targetStageId)).toBe(true);
    // Bumped exactly once each: a double-apply would show up here before it showed up anywhere else.
    expect(opportunities.every((row) => row.version === 2)).toBe(true);

    const transitions = await adminPrisma.transition.findMany({ where: { jobId: job.jobId } });
    expect(transitions).toHaveLength(TOTAL);
    expect(new Set(transitions.map((row) => row.opportunityId)).size).toBe(TOTAL);

    await runFinalizeSweep(adminPrisma);
    expect((await adminPrisma.job.findUniqueOrThrow({ where: { id: job.jobId } })).status).toBe(
      'completed',
    );
  });

  it('is a no-op when a worker comes back to an already finished job', async () => {
    const job = await enrollFreshOpportunities(fixture, CHUNK_SIZE);
    await claimAndApplyChunk(adminPrisma, job.jobId);
    await runFinalizeSweep(adminPrisma);

    const before = await adminPrisma.opportunity.findMany({
      where: { id: { in: job.opportunityIds } },
      orderBy: { id: 'asc' },
    });

    // A loop that was mid-flight when the job finished, arriving late.
    const late = await claimAndApplyChunk(adminPrisma, job.jobId);

    expect(late).toMatchObject({ outcome: 'applied', claimedCount: 0 });
    const after = await adminPrisma.opportunity.findMany({
      where: { id: { in: job.opportunityIds } },
      orderBy: { id: 'asc' },
    });
    expect(after.map((row) => row.version)).toEqual(before.map((row) => row.version));
    expect(await adminPrisma.transition.count({ where: { jobId: job.jobId } })).toBe(CHUNK_SIZE);
    expect((await adminPrisma.job.findUniqueOrThrow({ where: { id: job.jobId } })).status).toBe(
      'completed',
    );
  });
});
