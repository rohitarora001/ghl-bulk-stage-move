import request from 'supertest';
import { container } from '@app/container';
import { createApp } from '@app/createApp';
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
 * The filter is stored, never re-evaluated. `job_items` is the guest list, and the guest list is
 * closed at submission.
 *
 * Both directions matter, and they are not symmetric conveniences — they are what makes progress
 * answerable at all. If the filter were re-run, a row created after submission would join the job
 * and the denominator would move under the caller; a row edited out of the filter would vanish
 * from it and `done + pending` would stop adding up to `totalCount`.
 */

const app = createApp();

async function drain(jobId: string): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    const result = await workerFor(adminPrisma).processChunk(jobId);
    if (result.outcome !== 'applied') throw new Error(`chunk failed: ${JSON.stringify(result)}`);
    if (result.claimedCount === 0) return;
  }
  throw new Error('drain did not finish in 50 rounds');
}

async function submit(fixture: WorkspaceFixture, key: string): Promise<string> {
  const response = await request(app)
    .post('/jobs/bulk-move')
    .set('X-Workspace-Id', fixture.workspaceId)
    .set('Idempotency-Key', key)
    .send({ filter: { status: 'open' }, targetStageId: fixture.stageIds[1]! });
  expect(response.status).toBe(202);
  return response.body.jobId;
}

describe('snapshot, not live set', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('never picks up a row that only starts matching after submission', async () => {
    const matching = await createOpportunity(fixture, { status: 'open' });
    // 'lost' at submission time, so the filter does not see it.
    const latecomer = await createOpportunity(fixture, { status: 'lost' });

    const jobId = await submit(fixture, 'snapshot-1');

    // Now it would match — and must still be ignored, because the guest list is already closed.
    await adminPrisma.$executeRaw`
      UPDATE opportunities SET status = 'open' WHERE id = ${latecomer.id}::uuid
    `;
    await drain(jobId);

    const items = await adminPrisma.jobItem.findMany({ where: { jobId } });
    expect(items).toHaveLength(1);
    expect(items[0]!.opportunityId).toBe(matching.id);

    const untouched = await adminPrisma.opportunity.findUniqueOrThrow({
      where: { id: latecomer.id },
    });
    expect(untouched.stageId).toBe(latecomer.stageId);
    expect(untouched.version).toBe(latecomer.version);
    expect(await adminPrisma.transition.count({ where: { opportunityId: latecomer.id } })).toBe(0);
  });

  it('also ignores a row created after submission, even one that matches perfectly', async () => {
    await createOpportunity(fixture, { status: 'open' });
    const jobId = await submit(fixture, 'snapshot-2');

    const newcomer = await createOpportunity(fixture, { status: 'open' });
    await drain(jobId);

    expect(await adminPrisma.jobItem.count({ where: { jobId } })).toBe(1);
    const untouched = await adminPrisma.opportunity.findUniqueOrThrow({
      where: { id: newcomer.id },
    });
    expect(untouched.stageId).toBe(newcomer.stageId);
    expect(untouched.version).toBe(newcomer.version);
  });

  it('still moves a row edited out of the filter, because selection is final', async () => {
    const leaver = await createOpportunity(fixture, { status: 'open' });
    const jobId = await submit(fixture, 'snapshot-3');

    // Edited so it no longer matches. This is NOT a stage change and NOT a version bump, so the
    // job's frozen expected_version still holds and the move proceeds.
    await adminPrisma.$executeRaw`
      UPDATE opportunities SET status = 'lost' WHERE id = ${leaver.id}::uuid
    `;
    await drain(jobId);

    const moved = await adminPrisma.opportunity.findUniqueOrThrow({ where: { id: leaver.id } });
    expect(moved.stageId).toBe(fixture.stageIds[1]!);
    expect(moved.version).toBe(leaver.version + 1);
    expect(moved.status).toBe('lost');

    const item = await adminPrisma.jobItem.findFirstOrThrow({ where: { jobId } });
    expect(item.status).toBe('done');
    expect(await adminPrisma.transition.count({ where: { opportunityId: leaver.id, jobId } })).toBe(
      1,
    );
  });

  it('records skipped_conflict when the edit that removed it from the filter also bumped version', async () => {
    const leaver = await createOpportunity(fixture, { status: 'open' });
    const jobId = await submit(fixture, 'snapshot-4');

    // A human moved it somewhere else. That bumps version, so the frozen expected_version no
    // longer matches and the manual edit wins — selection being final does not mean the job
    // overwrites people.
    await container.opportunitiesService.moveOpportunity({
      workspaceId: fixture.workspaceId,
      opportunityId: leaver.id,
      targetStageId: fixture.stageIds[2]!,
    });
    await drain(jobId);

    const item = await adminPrisma.jobItem.findFirstOrThrow({ where: { jobId } });
    expect(item.status).toBe('skipped_conflict');

    const kept = await adminPrisma.opportunity.findUniqueOrThrow({ where: { id: leaver.id } });
    expect(kept.stageId).toBe(fixture.stageIds[2]!);
    expect(await adminPrisma.transition.count({ where: { opportunityId: leaver.id, jobId } })).toBe(
      0,
    );
  });
});
