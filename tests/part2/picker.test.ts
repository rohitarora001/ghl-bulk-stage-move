import { pickJobWithClaimableWork, touchLastProgress } from '../../src/worker/queries';
import { enrollFreshOpportunities } from '../setup/jobFixtures';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * The picker decides which job a loop works on, and both halves of it earn their keep.
 *
 * Scoping to `status = 'running'` alone is not enough: a job whose every remaining item is backed
 * off into the future is running but unworkable, and because the picker orders by progress it would
 * be handed back the same unworkable job forever — claiming nothing, touching nothing, and starving
 * every other tenant's job behind it.
 */

async function backOff(jobId: string, seconds: number): Promise<void> {
  await adminPrisma.$executeRaw`
    UPDATE job_items
    SET next_attempt_at = now() + (interval '1 second' * ${seconds})
    WHERE job_id = ${jobId}::uuid AND status = 'pending'
  `;
}

async function setProgress(jobId: string, secondsAgo: number | null): Promise<void> {
  await adminPrisma.$executeRaw`
    UPDATE jobs
    SET last_progress_at = CASE
      WHEN ${secondsAgo}::int IS NULL THEN NULL
      ELSE now() - (interval '1 second' * ${secondsAgo}::int)
    END
    WHERE id = ${jobId}::uuid
  `;
}

describe('pickJobWithClaimableWork', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('skips a running job whose remaining items are all backed off', async () => {
    const backedOff = await enrollFreshOpportunities(fixture, 2);
    await backOff(backedOff.jobId, 3600);
    // Older progress, so ordering alone would prefer it — only the claimability check excludes it.
    await setProgress(backedOff.jobId, 600);

    const claimable = await enrollFreshOpportunities(fixture, 2, {
      sourceStageId: fixture.stageIds[2]!,
      targetStageId: fixture.stageIds[1]!,
    });
    await setProgress(claimable.jobId, 1);

    expect(await pickJobWithClaimableWork(adminPrisma)).toBe(claimable.jobId);
  });

  it('returns nothing when every running job is backed off', async () => {
    const job = await enrollFreshOpportunities(fixture, 2);
    await backOff(job.jobId, 3600);

    expect(await pickJobWithClaimableWork(adminPrisma)).toBeNull();
  });

  it('ignores jobs that are no longer running', async () => {
    const job = await enrollFreshOpportunities(fixture, 2);
    await adminPrisma.job.update({ where: { id: job.jobId }, data: { status: 'completed' } });

    expect(await pickJobWithClaimableWork(adminPrisma)).toBeNull();
  });

  it('prefers the job that has waited longest, and rotates as they progress', async () => {
    const older = await enrollFreshOpportunities(fixture, 4);
    const newer = await enrollFreshOpportunities(fixture, 4, {
      sourceStageId: fixture.stageIds[2]!,
      targetStageId: fixture.stageIds[1]!,
    });
    await setProgress(older.jobId, 30);
    await setProgress(newer.jobId, 5);

    expect(await pickJobWithClaimableWork(adminPrisma)).toBe(older.jobId);

    // A loop worked it and recorded progress; the other job must now be first in line.
    await touchLastProgress(adminPrisma, older.jobId);
    expect(await pickJobWithClaimableWork(adminPrisma)).toBe(newer.jobId);

    await touchLastProgress(adminPrisma, newer.jobId);
    expect(await pickJobWithClaimableWork(adminPrisma)).toBe(older.jobId);
  });

  it('puts a job that has never progressed at the front of the queue', async () => {
    const started = await enrollFreshOpportunities(fixture, 2);
    await setProgress(started.jobId, 300);
    const brandNew = await enrollFreshOpportunities(fixture, 2, {
      sourceStageId: fixture.stageIds[2]!,
      targetStageId: fixture.stageIds[1]!,
    });
    await setProgress(brandNew.jobId, null);

    // NULLS FIRST: a submitted job must start moving rather than queue behind a long-running one.
    expect(await pickJobWithClaimableWork(adminPrisma)).toBe(brandNew.jobId);
  });
});
