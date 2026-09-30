import {
  adminPrisma,
  createOpportunity,
  disconnectTestDb,
  resetDb,
  seedBaseFixture,
} from '../setup/testDb';

/**
 * The bulk job's correctness rests on constraints, not on application checks: two requests that
 * race past an application-level "does this key already exist?" both win, whereas two inserts
 * racing at a unique index means exactly one wins and the other gets 23505. These tests assert
 * the database actually refuses, and that the partial indexes the hot queries were planned
 * around exist with the predicates that make them selective.
 */

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

async function createJob(
  workspaceId: string,
  targetStageId: string,
  idempotencyKey: string,
): Promise<string> {
  const [row] = await adminPrisma.$queryRaw<{ id: string }[]>`
    INSERT INTO jobs (workspace_id, idempotency_key, filter, target_stage_id, total_count)
    VALUES (${workspaceId}::uuid, ${idempotencyKey}, '{}'::jsonb, ${targetStageId}::uuid, 0)
    RETURNING id
  `;
  return row!.id;
}

async function createJobItem(jobId: string, opportunityId: string): Promise<void> {
  await adminPrisma.$executeRaw`
    INSERT INTO job_items (job_id, opportunity_id, expected_version)
    VALUES (${jobId}::uuid, ${opportunityId}::uuid, 1)
  `;
}

/**
 * Prisma wraps raw-query failures in P2010 and carries the real SQLSTATE in `meta.code`.
 * Asserting on the SQLSTATE rather than the message keeps the test from breaking on a Postgres
 * upgrade's reworded error text, while still proving *which* rule refused.
 */
async function sqlStateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const meta = (error as { meta?: { code?: string } }).meta;
    return meta?.code ?? (error as { code?: string }).code;
  }
}

describe('jobs and job_items schema', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('accepts an idempotency key once per workspace and rejects the duplicate', async () => {
    const { a, b } = await seedBaseFixture();

    await createJob(a.workspaceId, a.stageIds[1]!, 'move-to-qualified');

    // Same workspace, same key: the second submission of a retried request must not create a
    // second job, and the database is what guarantees it under concurrency.
    expect(await sqlStateOf(() => createJob(a.workspaceId, a.stageIds[1]!, 'move-to-qualified')))
      .toBe(UNIQUE_VIOLATION);

    // A different tenant reusing the same key is a different job — keys are scoped per workspace,
    // not global, or one tenant's client could block another tenant's submission.
    await expect(
      createJob(b.workspaceId, b.stageIds[1]!, 'move-to-qualified'),
    ).resolves.toBeTruthy();
  });

  it('rejects the same opportunity enrolled twice in one job', async () => {
    const { a } = await seedBaseFixture();
    const opportunity = await createOpportunity(a);
    const jobId = await createJob(a.workspaceId, a.stageIds[1]!, 'dedupe');

    await createJobItem(jobId, opportunity.id);

    // The infra-facing half of idempotency: a retried snapshot insert cannot enroll the same
    // opportunity twice, so it cannot be moved twice or counted twice in progress.
    expect(await sqlStateOf(() => createJobItem(jobId, opportunity.id))).toBe(UNIQUE_VIOLATION);

    // The same opportunity in a *different* job is legitimate — jobs run sequentially over time.
    const otherJobId = await createJob(a.workspaceId, a.stageIds[2]!, 'dedupe-2');
    await expect(createJobItem(otherJobId, opportunity.id)).resolves.toBeUndefined();
  });

  it('has the partial indexes the claim, picker, and attribution queries were planned around', async () => {
    const indexes = await adminPrisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'jobs_running_progress_idx',
          'job_items_claimable_idx',
          'transitions_job_opportunity_uq'
        )
    `;
    const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));

    expect([...byName.keys()].sort()).toEqual([
      'job_items_claimable_idx',
      'jobs_running_progress_idx',
      'transitions_job_opportunity_uq',
    ]);

    // The picker scans only running jobs; without the predicate it would also walk every
    // completed job the tenant has ever run.
    expect(byName.get('jobs_running_progress_idx')).toMatch(/\(last_progress_at\)/);
    expect(byName.get('jobs_running_progress_idx')).toMatch(/WHERE \(status = 'running'/);

    // The claim query's index: (job_id, next_attempt_at, id) over pending rows only, so a job
    // that is 99% done does not walk the done rows to find the last chunk.
    expect(byName.get('job_items_claimable_idx')).toMatch(/\(job_id, next_attempt_at, id\)/);
    expect(byName.get('job_items_claimable_idx')).toMatch(/WHERE \(status = 'pending'/);

    // Job-attributed transitions are unique per (job, opportunity); manual transitions carry a
    // NULL job_id and are excluded, so a user may move the same opportunity any number of times.
    expect(byName.get('transitions_job_opportunity_uq')).toMatch(/UNIQUE INDEX/);
    expect(byName.get('transitions_job_opportunity_uq')).toMatch(/WHERE \(job_id IS NOT NULL\)/);
  });
});
