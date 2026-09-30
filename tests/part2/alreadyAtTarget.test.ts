import { enrollJob } from '../setup/jobFixtures';
import {
  adminPrisma,
  createOpportunity,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';
import { workerFor } from '../setup/workerFixtures';

/**
 * An opportunity already sitting in the target stage is a no-op by definition, and must be
 * treated as one: no UPDATE, no version bump, no transition row.
 *
 * Without this bucket, "a replayed job converges to the same final stage" is only half true. The
 * stage converges, but the second run still sees a matching version (nothing else touched the
 * row), so it re-bumps `version` — invalidating every other job's frozen `expected_version` for
 * no reason — and writes a fake X → X transition for a change that never happened.
 */

describe('opportunities already at the target stage', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('marks the item done without touching the row or writing a transition', async () => {
    const target = fixture.stageIds[1]!;
    const alreadyThere = await createOpportunity(fixture, { stageId: target });
    const job = await enrollJob(fixture, {
      targetStageId: target,
      opportunities: [alreadyThere],
    });

    const result = await workerFor(adminPrisma).processChunk(job.jobId);

    expect(result).toMatchObject({ outcome: 'applied', claimedCount: 1, conflictCount: 0 });

    const item = await adminPrisma.jobItem.findFirstOrThrow({ where: { jobId: job.jobId } });
    expect(item.status).toBe('done');

    const row = await adminPrisma.opportunity.findUniqueOrThrow({ where: { id: alreadyThere.id } });
    expect(row.stageId).toBe(target);
    expect(row.version).toBe(alreadyThere.version);

    expect(await adminPrisma.transition.count({ where: { opportunityId: alreadyThere.id } })).toBe(
      0,
    );
  });

  it('is decided by the stage, not by the version', async () => {
    const target = fixture.stageIds[1]!;
    const alreadyThere = await createOpportunity(fixture, { stageId: target });
    // A stale expected_version: something moved this row around before the job got to it, and it
    // happens to have ended up at the target anyway.
    const job = await enrollJob(fixture, {
      targetStageId: target,
      opportunities: [{ id: alreadyThere.id, version: alreadyThere.version + 7 }],
    });

    const result = await workerFor(adminPrisma).processChunk(job.jobId);

    // `done`, not `skipped_conflict`: the outcome the job wanted is already the case, so there is
    // nothing for a human's edit to have conflicted with.
    expect(result).toMatchObject({ outcome: 'applied', doneCount: 1, conflictCount: 0 });
    const item = await adminPrisma.jobItem.findFirstOrThrow({ where: { jobId: job.jobId } });
    expect(item.status).toBe('done');
    expect(await adminPrisma.transition.count()).toBe(0);
  });

  it('still moves the rest of the chunk', async () => {
    const target = fixture.stageIds[1]!;
    const alreadyThere = await createOpportunity(fixture, { stageId: target });
    const moving = await createOpportunity(fixture, { stageId: fixture.stageIds[0]! });
    const job = await enrollJob(fixture, {
      targetStageId: target,
      opportunities: [alreadyThere, moving],
    });

    const result = await workerFor(adminPrisma).processChunk(job.jobId);

    expect(result).toMatchObject({ outcome: 'applied', claimedCount: 2, doneCount: 2 });
    const rows = await adminPrisma.opportunity.findMany({
      where: { id: { in: [alreadyThere.id, moving.id] } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(alreadyThere.id)!.version).toBe(alreadyThere.version);
    expect(byId.get(moving.id)!.version).toBe(moving.version + 1);
    expect(await adminPrisma.transition.count()).toBe(1);
  });
});
