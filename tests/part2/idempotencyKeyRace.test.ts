import request from 'supertest';
import { createApp } from '@app/createApp';
import {
  adminPrisma,
  createOpportunity,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * The check-then-insert in `submitBulkMoveJob` is a TOCTOU window: two retries that arrive
 * together both find no existing job and both try to insert. The unique constraint decides, and
 * the loser must return the winner's job — surfacing its 23505 as a 500 would defeat the entire
 * point of having the constraint, since the client's retry is exactly what produced the race.
 */

const app = createApp();

function submit(fixture: WorkspaceFixture, key: string) {
  return request(app)
    .post('/jobs/bulk-move')
    .set('X-Workspace-Id', fixture.workspaceId)
    .set('Idempotency-Key', key)
    .send({ filter: { stageId: fixture.stageIds[0] }, targetStageId: fixture.stageIds[1] });
}

describe('concurrent submissions with the same idempotency key', () => {
  let a: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    a = await createWorkspace('workspace-a');
    for (let index = 0; index < 5; index += 1) {
      await createOpportunity(a, { stageId: a.stageIds[0]! });
    }
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('lets both requests succeed and produces exactly one job', async () => {
    const [first, second] = await Promise.all([submit(a, 'raced'), submit(a, 'raced')]);

    // Which one wins is timing; that both are answered successfully is not.
    expect(first.status).toBeGreaterThanOrEqual(200);
    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeGreaterThanOrEqual(200);
    expect(second.status).toBeLessThan(300);
    expect(second.body.jobId).toBe(first.body.jobId);

    expect(await adminPrisma.job.count()).toBe(1);
    // One snapshot's worth, not two: the loser's snapshot must not survive its rolled-back job.
    expect(await adminPrisma.jobItem.count()).toBe(5);

    // Exactly one of them created the job.
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 202]);
  });

  it('answers ten simultaneous retries with the same job', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => submit(a, 'stampede')));

    const jobIds = new Set(responses.map((response) => response.body.jobId));
    expect(jobIds.size).toBe(1);
    expect(responses.every((response) => response.status < 300)).toBe(true);
    expect(await adminPrisma.job.count()).toBe(1);
    expect(await adminPrisma.jobItem.count()).toBe(5);
  });
});
