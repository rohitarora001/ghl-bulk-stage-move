import request from 'supertest';
import { createApp } from '../../src/api/server';
import { enrollFreshOpportunities } from '../setup/jobFixtures';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * Progress is computed from committed rows on every call — never from a counter the worker keeps in
 * memory, which a restart would lose and a second worker would never see.
 *
 * `backedOff` is what makes the "stuck" answer honest rather than merely plausible. Without it, a
 * job whose remaining items are all waiting out their own exponential backoff — expected, self
 * healing — looks exactly like a job whose worker is dead: both stall `last_progress_at`. With it,
 * the two are distinguishable, and the endpoint stops guessing.
 */

const app = createApp();

async function get(workspaceId: string, jobId: string) {
  return request(app).get(`/jobs/${jobId}`).set('X-Workspace-Id', workspaceId);
}

async function setItemStatus(
  jobId: string,
  count: number,
  status: 'done' | 'skipped_conflict' | 'failed',
  offset = 0,
): Promise<void> {
  const items = await adminPrisma.jobItem.findMany({
    where: { jobId, status: 'pending' },
    orderBy: { id: 'asc' },
    skip: offset,
    take: count,
  });
  await adminPrisma.jobItem.updateMany({
    where: { id: { in: items.map((item) => item.id) } },
    data: { status },
  });
}

describe('GET /jobs/:id', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('reports the committed breakdown exactly', async () => {
    const job = await enrollFreshOpportunities(fixture, 10);
    await setItemStatus(job.jobId, 4, 'done');
    await setItemStatus(job.jobId, 2, 'skipped_conflict');
    await setItemStatus(job.jobId, 1, 'failed');

    const response = await get(fixture.workspaceId, job.jobId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: job.jobId,
      status: 'running',
      totalCount: 10,
      matchedCount: 10,
      truncated: false,
      counts: { done: 4, pending: 3, skippedConflict: 2, failed: 1 },
      backedOff: 0,
      errorMessage: null,
    });
  });

  it('counts only pending items whose backoff has not expired as backedOff', async () => {
    const job = await enrollFreshOpportunities(fixture, 5);
    await adminPrisma.$executeRaw`
      UPDATE job_items SET next_attempt_at = now() + interval '60 seconds', attempts = 1
      WHERE id IN (SELECT id FROM job_items WHERE job_id = ${job.jobId}::uuid ORDER BY id LIMIT 2)
    `;
    // A backoff that has already expired is claimable again, so it is not backed off any more.
    await adminPrisma.$executeRaw`
      UPDATE job_items SET next_attempt_at = now() - interval '5 seconds', attempts = 1
      WHERE id IN (SELECT id FROM job_items WHERE job_id = ${job.jobId}::uuid ORDER BY id OFFSET 2 LIMIT 1)
    `;

    const response = await get(fixture.workspaceId, job.jobId);

    expect(response.body.counts.pending).toBe(5);
    expect(response.body.backedOff).toBe(2);
  });

  it('classifies a job whose every remaining item is backed off as backing_off', async () => {
    const job = await enrollFreshOpportunities(fixture, 3);
    await setItemStatus(job.jobId, 1, 'done');
    await adminPrisma.$executeRaw`
      UPDATE job_items SET next_attempt_at = now() + interval '30 seconds', attempts = 2
      WHERE job_id = ${job.jobId}::uuid AND status = 'pending'
    `;
    // Stalled progress — which on its own says nothing about whether anything is wrong.
    await adminPrisma.$executeRaw`
      UPDATE jobs SET last_progress_at = now() - interval '10 minutes' WHERE id = ${job.jobId}::uuid
    `;

    const response = await get(fixture.workspaceId, job.jobId);

    // Expected and self-healing: nothing is claimable, so no worker is failing to claim it.
    expect(response.body.classification).toBe('backing_off');
    expect(response.body.backedOff).toBe(response.body.counts.pending);
  });

  it('classifies claimable work that nobody is claiming as stuck', async () => {
    const job = await enrollFreshOpportunities(fixture, 3);
    await adminPrisma.$executeRaw`
      UPDATE job_items SET next_attempt_at = now() + interval '30 seconds', attempts = 1
      WHERE id IN (SELECT id FROM job_items WHERE job_id = ${job.jobId}::uuid ORDER BY id LIMIT 1)
    `;
    await adminPrisma.$executeRaw`
      UPDATE jobs SET last_progress_at = now() - interval '10 minutes' WHERE id = ${job.jobId}::uuid
    `;

    const response = await get(fixture.workspaceId, job.jobId);

    // Two items are claimable right now and nothing has claimed them for ten minutes: a human
    // needs to look at the worker.
    expect(response.body.classification).toBe('stuck');
    expect(response.body.backedOff).toBeLessThan(response.body.counts.pending);
  });

  it('reports a recently progressing job as running, not stuck', async () => {
    const job = await enrollFreshOpportunities(fixture, 3);
    await setItemStatus(job.jobId, 1, 'done');
    await adminPrisma.$executeRaw`
      UPDATE jobs SET last_progress_at = now() WHERE id = ${job.jobId}::uuid
    `;

    const response = await get(fixture.workspaceId, job.jobId);

    expect(response.body.classification).toBe('running');
  });

  it('reports terminal jobs from jobs.status, with the failure reason', async () => {
    const job = await enrollFreshOpportunities(fixture, 2);
    await setItemStatus(job.jobId, 1, 'done');
    await setItemStatus(job.jobId, 1, 'failed');
    await adminPrisma.job.update({
      where: { id: job.jobId },
      data: { status: 'failed', errorMessage: '1 item(s) failed after max attempts' },
    });

    const response = await get(fixture.workspaceId, job.jobId);

    expect(response.body.classification).toBe('failed');
    expect(response.body.status).toBe('failed');
    expect(response.body.errorMessage).toContain('failed after max attempts');
    expect(response.body.counts).toMatchObject({ done: 1, failed: 1 });
  });

  it('does not reveal another workspace’s job', async () => {
    const other = await createWorkspace('workspace-b');
    const job = await enrollFreshOpportunities(fixture, 1);

    const response = await get(other.workspaceId, job.jobId);

    expect(response.status).toBe(404);
  });
});
