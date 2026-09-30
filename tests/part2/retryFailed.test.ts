import request from 'supertest';
import { container } from '@app/container';
import { createApp } from '@app/createApp';
import { claimAndApplyChunk } from '../../src/worker/claimAndApplyChunk';
import { enrollFreshOpportunities } from '../setup/jobFixtures';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * Retry-failed is a replay, not a force. It puts exhausted items back in the queue and lets the
 * normal chunk rules decide what happens to them — including the version check. An operator who
 * retries a batch after fixing whatever broke it must not thereby overwrite an edit a human made
 * while those items sat failed.
 */

const app = createApp();

async function failEverything(jobId: string): Promise<void> {
  await adminPrisma.$executeRaw`
    UPDATE job_items
    SET status = 'failed', attempts = 5, last_error = 'boom',
        next_attempt_at = now() + interval '1 hour'
    WHERE job_id = ${jobId}::uuid
  `;
  await adminPrisma.job.update({
    where: { id: jobId },
    data: { status: 'failed', errorMessage: '3 item(s) failed after max attempts' },
  });
}

async function retry(workspaceId: string, jobId: string) {
  return request(app).post(`/jobs/${jobId}/retry-failed`).set('X-Workspace-Id', workspaceId);
}

describe('POST /jobs/:id/retry-failed', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('returns failed items to the queue and the job to running, then drains', async () => {
    const job = await enrollFreshOpportunities(fixture, 3);
    await failEverything(job.jobId);

    const response = await retry(fixture.workspaceId, job.jobId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ jobId: job.jobId, retriedCount: 3 });

    const items = await adminPrisma.jobItem.findMany({ where: { jobId: job.jobId } });
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.status).toBe('pending');
      expect(item.attempts).toBe(0);
      expect(item.lastError).toBeNull();
      // Backoff cleared too: leaving next_attempt_at an hour out would make the retry a
      // no-op the operator could not distinguish from a working one.
      expect(item.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }

    const job2 = await adminPrisma.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(job2.status).toBe('running');
    expect(job2.errorMessage).toBeNull();

    const result = await claimAndApplyChunk(adminPrisma, job.jobId);
    expect(result).toMatchObject({ outcome: 'applied', claimedCount: 3, doneCount: 3 });
  });

  it('replays through the version check, so a manual edit made while failed still wins', async () => {
    const job = await enrollFreshOpportunities(fixture, 3);
    await failEverything(job.jobId);

    // A human moved one of the failed rows somewhere else entirely while the job was stalled.
    const elsewhere = fixture.stageIds[2]!;
    await container.opportunitiesService.moveOpportunity({
      workspaceId: fixture.workspaceId,
      opportunityId: job.opportunityIds[0]!,
      targetStageId: elsewhere,
    });

    await retry(fixture.workspaceId, job.jobId);
    const result = await claimAndApplyChunk(adminPrisma, job.jobId);

    expect(result).toMatchObject({ outcome: 'applied', claimedCount: 3, conflictCount: 1 });

    // The retry must not have touched expected_version: had it refreshed it, the job would have
    // dragged the opportunity back and the operator would never know they overwrote a human.
    const edited = await adminPrisma.opportunity.findUniqueOrThrow({
      where: { id: job.opportunityIds[0]! },
    });
    expect(edited.stageId).toBe(elsewhere);

    const conflicted = await adminPrisma.jobItem.findFirstOrThrow({
      where: { jobId: job.jobId, opportunityId: job.opportunityIds[0]! },
    });
    expect(conflicted.status).toBe('skipped_conflict');
  });

  it('is a harmless no-op when called twice', async () => {
    const job = await enrollFreshOpportunities(fixture, 3);
    await failEverything(job.jobId);

    await retry(fixture.workspaceId, job.jobId);
    const result = await claimAndApplyChunk(adminPrisma, job.jobId);
    expect(result).toMatchObject({ outcome: 'applied', doneCount: 3 });

    // Nothing is failed any more, so the second call has nothing to flip — and must not drag
    // finished items back into the queue.
    const second = await retry(fixture.workspaceId, job.jobId);

    expect(second.status).toBe(200);
    expect(second.body.retriedCount).toBe(0);

    const items = await adminPrisma.jobItem.findMany({ where: { jobId: job.jobId } });
    expect(items.every((item) => item.status === 'done')).toBe(true);
  });

  it('does not let one workspace retry another workspace’s job', async () => {
    const other = await createWorkspace('workspace-b');
    const job = await enrollFreshOpportunities(fixture, 1);
    await failEverything(job.jobId);

    const response = await retry(other.workspaceId, job.jobId);

    expect(response.status).toBe(404);
    const item = await adminPrisma.jobItem.findFirstOrThrow({ where: { jobId: job.jobId } });
    expect(item.status).toBe('failed');
  });
});
