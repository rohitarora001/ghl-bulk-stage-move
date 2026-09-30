import request from 'supertest';
import { resetConfigCache } from '@config';
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
 * A filter matching more than the cap is truncated rather than refused or silently widened, and
 * the response says so. A caller who is not told would watch a job complete at 100% having moved
 * a fraction of what they asked for — the most expensive kind of silent wrong answer.
 */

const MAX_ITEMS = 10;

let app: ReturnType<typeof createApp>;

function submit(fixture: WorkspaceFixture, key: string) {
  return request(app)
    .post('/jobs/bulk-move')
    .set('X-Workspace-Id', fixture.workspaceId)
    .set('Idempotency-Key', key)
    .send({ filter: { stageId: fixture.stageIds[0] }, targetStageId: fixture.stageIds[1] });
}

describe('bulk-move truncation at BULK_MAX_ITEMS', () => {
  let a: WorkspaceFixture;
  const originalMax = process.env.BULK_MAX_ITEMS;

  beforeAll(() => {
    process.env.BULK_MAX_ITEMS = String(MAX_ITEMS);
    resetConfigCache();
    app = createApp();
  });

  afterAll(async () => {
    if (originalMax === undefined) delete process.env.BULK_MAX_ITEMS;
    else process.env.BULK_MAX_ITEMS = originalMax;
    resetConfigCache();
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    a = await createWorkspace('workspace-a');
  });

  it('caps the snapshot at the limit, keeps the oldest rows, and reports the truncation', async () => {
    // 25 rows with distinct, increasing created_at so "oldest ten" is unambiguous.
    const created: { id: string; createdAt: Date }[] = [];
    for (let index = 0; index < 25; index += 1) {
      const createdAt = new Date(Date.UTC(2026, 0, 1 + index));
      const row = await createOpportunity(a, { stageId: a.stageIds[0]!, createdAt });
      created.push({ id: row.id, createdAt });
    }

    const response = await submit(a, 'truncate-me');

    expect(response.status).toBe(202);
    expect(response.body.totalCount).toBe(MAX_ITEMS);
    expect(response.body.truncated).toBe(true);
    // Null, not 25: counting the full match set would mean running the filter a second time
    // without a limit, which is the unbounded query the cap exists to avoid.
    expect(response.body.matchedCount).toBeNull();

    const items = await adminPrisma.jobItem.findMany({
      where: { jobId: response.body.jobId },
      select: { opportunityId: true },
    });
    expect(items).toHaveLength(MAX_ITEMS);

    // Deterministic selection by (created_at, id): a client who resubmits after the first job
    // finishes gets the next slice, rather than a random re-draw that revisits done rows.
    const expected = created.slice(0, MAX_ITEMS).map((row) => row.id).sort();
    expect(items.map((item) => item.opportunityId).sort()).toEqual(expected);

    const job = await adminPrisma.job.findUniqueOrThrow({ where: { id: response.body.jobId } });
    expect(job.truncated).toBe(true);
    expect(job.matchedCount).toBeNull();
    expect(job.totalCount).toBe(MAX_ITEMS);
  });

  it('reports an exact match count when the filter fits under the cap', async () => {
    for (let index = 0; index < 4; index += 1) {
      await createOpportunity(a, { stageId: a.stageIds[0]! });
    }

    const response = await submit(a, 'fits');

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ totalCount: 4, matchedCount: 4, truncated: false });
  });

  it('accepts a filter that matches nothing rather than refusing it', async () => {
    const response = await submit(a, 'empty');

    // A zero-match filter is a legitimate request whose answer is "nothing to do". Refusing it
    // would make every caller special-case an outcome that is not an error.
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ totalCount: 0, matchedCount: 0, truncated: false });
    expect(await adminPrisma.jobItem.count()).toBe(0);
  });
});
