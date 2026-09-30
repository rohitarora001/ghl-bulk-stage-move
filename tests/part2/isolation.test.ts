import request from 'supertest';
import { createApp } from '../../src/api/server';
import { claimAndApplyChunk } from '../../src/worker/claimAndApplyChunk';
import {
  adminPrisma,
  createOpportunity,
  disconnectTestDb,
  resetDb,
  seedBaseFixture,
  type BaseFixture,
} from '../setup/testDb';

/**
 * Tenant isolation, checked against the thing that could actually break it.
 *
 * The filter a caller submits names no workspace — it cannot, the caller has no business knowing
 * other workspaces exist. So the ONLY thing keeping B's rows out of A's snapshot is the
 * workspace predicate the submission query adds. This test makes B's rows match A's filter in
 * every respect a filter can express, so a missing predicate has nothing else to hide behind.
 */

const app = createApp();

/** Every column a job could plausibly touch, for an exact before/after comparison. */
async function snapshotWorkspace(workspaceId: string) {
  const opportunities = await adminPrisma.$queryRaw`
    SELECT id, stage_id, version, status, value, owner_id, updated_at
    FROM opportunities WHERE workspace_id = ${workspaceId}::uuid ORDER BY id
  `;
  const transitions = await adminPrisma.$queryRaw`
    SELECT id FROM transitions WHERE workspace_id = ${workspaceId}::uuid ORDER BY id
  `;
  const items = await adminPrisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM job_items ji
    JOIN jobs j ON j.id = ji.job_id WHERE j.workspace_id = ${workspaceId}::uuid
  `;
  return { opportunities, transitions, itemCount: Number(items[0]!.count) };
}

async function drain(jobId: string): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    const result = await claimAndApplyChunk(adminPrisma, jobId);
    if (result.outcome !== 'applied') throw new Error(`chunk failed: ${JSON.stringify(result)}`);
    if (result.claimedCount === 0) return;
  }
  throw new Error('drain did not finish in 50 rounds');
}

describe('workspace isolation', () => {
  let base: BaseFixture;

  beforeEach(async () => {
    await resetDb();
    base = await seedBaseFixture();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('leaves every row in another workspace byte-for-byte unchanged', async () => {
    // Deliberately identical shapes on both sides: same source stage position, same status, same
    // value. Nothing but the workspace id distinguishes B's rows from A's.
    for (let index = 0; index < 5; index += 1) {
      await createOpportunity(base.a, { stageId: base.a.stageIds[0]!, status: 'open', value: 100 });
      await createOpportunity(base.b, { stageId: base.b.stageIds[0]!, status: 'open', value: 100 });
    }

    const before = await snapshotWorkspace(base.b.workspaceId);

    const submitted = await request(app)
      .post('/jobs/bulk-move')
      .set('X-Workspace-Id', base.a.workspaceId)
      .set('Idempotency-Key', 'isolation-1')
      .send({ filter: { status: 'open', value: undefined }, targetStageId: base.a.stageIds[1]! });
    expect(submitted.status).toBe(202);
    expect(submitted.body.totalCount).toBe(5);

    await drain(submitted.body.jobId);

    const after = await snapshotWorkspace(base.b.workspaceId);
    expect(after).toEqual(before);
    expect(after.itemCount).toBe(0);
    expect(after.transitions).toHaveLength(0);

    // And A really did the work, so the comparison above is not passing because nothing ran.
    const movedA = await adminPrisma.opportunity.count({
      where: { workspaceId: base.a.workspaceId, stageId: base.a.stageIds[1]! },
    });
    expect(movedA).toBe(5);
  });

  it('will not accept a target stage belonging to another workspace', async () => {
    await createOpportunity(base.a, { stageId: base.a.stageIds[0]!, status: 'open' });

    const response = await request(app)
      .post('/jobs/bulk-move')
      .set('X-Workspace-Id', base.a.workspaceId)
      .set('Idempotency-Key', 'isolation-2')
      .send({ filter: { status: 'open' }, targetStageId: base.b.stageIds[1]! });

    expect(response.status).toBe(400);
    expect(await adminPrisma.job.count()).toBe(0);
  });

  it('will not report or retry another workspace’s job', async () => {
    await createOpportunity(base.a, { stageId: base.a.stageIds[0]!, status: 'open' });
    const submitted = await request(app)
      .post('/jobs/bulk-move')
      .set('X-Workspace-Id', base.a.workspaceId)
      .set('Idempotency-Key', 'isolation-3')
      .send({ filter: { status: 'open' }, targetStageId: base.a.stageIds[1]! });

    const progress = await request(app)
      .get(`/jobs/${submitted.body.jobId}`)
      .set('X-Workspace-Id', base.b.workspaceId);
    expect(progress.status).toBe(404);

    const retry = await request(app)
      .post(`/jobs/${submitted.body.jobId}/retry-failed`)
      .set('X-Workspace-Id', base.b.workspaceId);
    expect(retry.status).toBe(404);
  });
});
