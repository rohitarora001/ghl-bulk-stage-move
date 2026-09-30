import { container } from '@app/container';
import { ConflictError } from '@shared/errors';
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
 * The collision policy: when a human and a running job both touch the same record, the human wins.
 *
 * A person acting on one specific record right now is a stronger, fresher signal than a filter
 * snapshot that may be minutes old. Overwriting a just-made correction is silent data loss, so the
 * job stands down and says so — `skipped_conflict`, surfaced in the progress response, never
 * retried and never force-applied.
 *
 * The manual move runs through the real service rather than a raw UPDATE in the test: a policy that
 * only holds when the test writes the collision by hand is not a policy.
 */

describe('a manual move racing a running job', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('leaves the manual edit standing and marks the item skipped_conflict', async () => {
    const job = await enrollFreshOpportunities(fixture, 3);
    const [collided, ...untouched] = job.opportunityIds;
    const manualTarget = fixture.stageIds[2]!;

    // The human gets there first, between the snapshot and the chunk.
    const moved = await container.opportunitiesService.moveOpportunity({
      workspaceId: fixture.workspaceId,
      opportunityId: collided!,
      targetStageId: manualTarget,
    });
    expect(moved.version).toBe(2);

    const result = await workerFor(adminPrisma).processChunk(job.jobId);
    expect(result).toMatchObject({ outcome: 'applied', claimedCount: 3, conflictCount: 1 });

    const row = await adminPrisma.opportunity.findUniqueOrThrow({ where: { id: collided! } });
    // The manual move's target, not the job's — and bumped once, by the human, not twice.
    expect(row.stageId).toBe(manualTarget);
    expect(row.version).toBe(2);

    const item = await adminPrisma.jobItem.findFirstOrThrow({
      where: { jobId: job.jobId, opportunityId: collided! },
    });
    expect(item.status).toBe('skipped_conflict');
    // Not retried: a conflict is a decision, not a transient failure.
    expect(item.attempts).toBe(0);

    // No job-attributed audit row for a move the job did not make.
    expect(
      await adminPrisma.transition.count({ where: { jobId: job.jobId, opportunityId: collided! } }),
    ).toBe(0);
    // The human's move is audited, with no job attribution.
    const manual = await adminPrisma.transition.findFirstOrThrow({
      where: { opportunityId: collided!, jobId: null },
    });
    expect(manual.fromStageId).toBe(fixture.stageIds[0]);
    expect(manual.toStageId).toBe(manualTarget);

    // The rest of the chunk is unaffected — one collision does not stall a job.
    const others = await adminPrisma.opportunity.findMany({ where: { id: { in: untouched } } });
    expect(others.every((other) => other.stageId === job.targetStageId)).toBe(true);
    expect(others.every((other) => other.version === 2)).toBe(true);
  });

  it('is not a conflict when the human moved the record where the job was taking it', async () => {
    const job = await enrollFreshOpportunities(fixture, 1);
    const collided = job.opportunityIds[0]!;

    await container.opportunitiesService.moveOpportunity({
      workspaceId: fixture.workspaceId,
      opportunityId: collided,
      targetStageId: job.targetStageId,
    });

    const result = await workerFor(adminPrisma).processChunk(job.jobId);

    // The outcome the job wanted is already the case, so there is nothing to have conflicted with.
    expect(result).toMatchObject({ outcome: 'applied', doneCount: 1, conflictCount: 0 });
    const row = await adminPrisma.opportunity.findUniqueOrThrow({ where: { id: collided } });
    expect(row.version).toBe(2);
    expect(await adminPrisma.transition.count({ where: { jobId: job.jobId } })).toBe(0);
  });

  it('rejects a manual move whose expectedVersion is stale', async () => {
    const job = await enrollFreshOpportunities(fixture, 1);
    const target = job.opportunityIds[0]!;
    await container.opportunitiesService.moveOpportunity({
      workspaceId: fixture.workspaceId,
      opportunityId: target,
      targetStageId: fixture.stageIds[2]!,
    });

    // A second client holding the version it read before the first move.
    const stale = container.opportunitiesService.moveOpportunity({
      workspaceId: fixture.workspaceId,
      opportunityId: target,
      targetStageId: fixture.stageIds[1]!,
      expectedVersion: 1,
    });

    await expect(stale).rejects.toMatchObject({ statusCode: 409 });
    await expect(stale).rejects.toBeInstanceOf(ConflictError);
    const row = await adminPrisma.opportunity.findUniqueOrThrow({ where: { id: target } });
    expect(row.stageId).toBe(fixture.stageIds[2]);
    expect(row.version).toBe(2);
  });

  it('refuses a target stage from another workspace', async () => {
    const other = await createWorkspace('workspace-b');
    const job = await enrollFreshOpportunities(fixture, 1);

    const crossTenant = container.opportunitiesService.moveOpportunity({
      workspaceId: fixture.workspaceId,
      opportunityId: job.opportunityIds[0]!,
      targetStageId: other.stageIds[0]!,
    });

    // Moving a record into another tenant's pipeline stage is a data-isolation breach, not a
    // routine validation miss.
    await expect(crossTenant).rejects.toMatchObject({ statusCode: 400 });
  });
});
