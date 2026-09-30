import request from 'supertest';
import { createApp } from '../../src/api/server';
import {
  adminPrisma,
  createOpportunity,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * A client that times out and retries must not enrol the same 50 000 opportunities twice. The
 * key is scoped per workspace, so one tenant's choice of key cannot block another's submission.
 */

const app = createApp();

function submit(fixture: WorkspaceFixture, key: string) {
  return request(app)
    .post('/jobs/bulk-move')
    .set('X-Workspace-Id', fixture.workspaceId)
    .set('Idempotency-Key', key)
    .send({ filter: { stageId: fixture.stageIds[0] }, targetStageId: fixture.stageIds[1] });
}

describe('bulk-move idempotency', () => {
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    a = await createWorkspace('workspace-a');
    b = await createWorkspace('workspace-b');
    await createOpportunity(a, { stageId: a.stageIds[0]! });
    await createOpportunity(a, { stageId: a.stageIds[0]! });
    await createOpportunity(b, { stageId: b.stageIds[0]! });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('replays the original job for a repeated key instead of enrolling the work twice', async () => {
    const first = await submit(a, 'retry-me');
    expect(first.status).toBe(202);

    const second = await submit(a, 'retry-me');

    // 200, not 202: nothing new was accepted, and the caller gets the job they already have.
    expect(second.status).toBe(200);
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(second.body).toMatchObject({ totalCount: 2, matchedCount: 2, truncated: false });

    expect(await adminPrisma.job.count()).toBe(1);
    expect(await adminPrisma.jobItem.count({ where: { jobId: first.body.jobId } })).toBe(2);
    expect(await adminPrisma.jobItem.count()).toBe(2);
  });

  it('treats the same key in another workspace as an unrelated submission', async () => {
    const first = await submit(a, 'shared-key');
    const other = await submit(b, 'shared-key');

    expect(first.status).toBe(202);
    expect(other.status).toBe(202);
    expect(other.body.jobId).not.toBe(first.body.jobId);
    expect(await adminPrisma.job.count()).toBe(2);
  });
});
