import { resetConfigCache } from '@config';
import { runLoop, runSweepLoop } from '@app/worker';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';
import { workerFor } from '../setup/workerFixtures';

/**
 * The proof the whole design rests on.
 *
 * Nothing edits a record by hand in this test, so a `skipped_conflict` cannot be a real collision —
 * it can only be one the concurrency mechanism manufactured. Three loops claim from the same job at
 * the same time; if the claim and the apply were two transactions, the locks would be released
 * between them and a loop would re-read a version its own earlier transaction no longer had a claim
 * on, reporting conflicts against itself. Zero conflicts, exactly one transition per opportunity,
 * exactly one version bump each: that is what a correct transaction boundary looks like from
 * outside.
 */

const CHUNK_SIZE = 50;
const LOOPS = 4;
const TOTAL = 2500; // ≥ 5 chunks, so the loops genuinely overlap.

const ENV: Record<string, string> = {
  CHUNK_SIZE: String(CHUNK_SIZE),
  SWEEP_INTERVAL_MS: '200',
  IDLE_BACKOFF_MS: '10',
  CLAIM_BACKOFF_MS: '10',
};

/** Bulk-seeds the opportunities and the job snapshot in two set-based statements. */
async function seedJob(fixture: WorkspaceFixture, total: number = TOTAL): Promise<string> {
  const sourceStageId = fixture.stageIds[0]!;
  const targetStageId = fixture.stageIds[1]!;
  await adminPrisma.$executeRaw`
    INSERT INTO opportunities (workspace_id, pipeline_id, stage_id, name, value, status, owner_id)
    SELECT ${fixture.workspaceId}::uuid, ${fixture.pipelineId}::uuid, ${sourceStageId}::uuid,
           'opp ' || n, 100.00, 'open'::opportunity_status, gen_random_uuid()
    FROM generate_series(1, ${total}) AS n
  `;
  const job = await adminPrisma.job.create({
    data: {
      workspaceId: fixture.workspaceId,
      idempotencyKey: `concurrent-loops-${total}`,
      filter: {},
      targetStageId,
      totalCount: total,
      matchedCount: total,
    },
  });
  await adminPrisma.$executeRaw`
    INSERT INTO job_items (job_id, opportunity_id, expected_version, status)
    SELECT ${job.id}::uuid, o.id, o.version, 'pending'::job_item_status
    FROM opportunities o
    WHERE o.workspace_id = ${fixture.workspaceId}::uuid AND o.stage_id = ${sourceStageId}::uuid
  `;
  return job.id;
}

async function waitForCompletion(jobId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await adminPrisma.job.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== 'running' || Date.now() > deadline) return job.status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('three loops draining one job with no manual edits', () => {
  let fixture: WorkspaceFixture;
  const original: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      original[key] = process.env[key];
      process.env[key] = value;
    }
    resetConfigCache();
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
    await disconnectTestDb();
  });

  it('applies every item exactly once and manufactures no conflicts', async () => {
    const jobId = await seedJob(fixture);

    const controller = new AbortController();
    // Staggered starts. Loops launched in the same millisecond run phase-aligned — every loop
    // claiming while the others claim, applying while the others apply — which is the one schedule
    // where a two-transaction design never gets caught. Real workers start at different times.
    const loops = Array.from({ length: LOOPS }, async (_, index) => {
      await new Promise((resolve) => setTimeout(resolve, index * 7));
      return runLoop(index + 1, controller.signal, adminPrisma);
    });
    // The sweeper is what finalizes the job; the loops only drain it.
    loops.push(runSweepLoop(controller.signal, adminPrisma));

    let status: string;
    try {
      status = await waitForCompletion(jobId, 60_000);
    } finally {
      controller.abort();
      await Promise.all(loops);
    }

    expect(status).toBe('completed');

    const counts = await adminPrisma.jobItem.groupBy({
      by: ['status'],
      where: { jobId },
      _count: { _all: true },
    });
    const byStatus = new Map(counts.map((row) => [row.status, row._count._all]));
    expect(byStatus.get('done')).toBe(TOTAL);
    // With no manual edits anywhere, every one of these would be a conflict the mechanism invented.
    expect(byStatus.get('skipped_conflict')).toBeUndefined();
    expect(byStatus.get('failed')).toBeUndefined();

    const [versions] = await adminPrisma.$queryRaw<
      { min: number; max: number; wrong_stage: bigint }[]
    >`
      SELECT min(version)::int AS min, max(version)::int AS max,
             count(*) FILTER (WHERE stage_id <> ${fixture.stageIds[1]!}::uuid) AS wrong_stage
      FROM opportunities WHERE workspace_id = ${fixture.workspaceId}::uuid
    `;
    // Exactly one bump each: 1 would mean a dropped apply, 3 a double-apply.
    expect(versions!.min).toBe(2);
    expect(versions!.max).toBe(2);
    expect(Number(versions!.wrong_stage)).toBe(0);

    const transitions = await adminPrisma.$queryRaw<{ total: bigint; distinct: bigint }[]>`
      SELECT count(*) AS total, count(DISTINCT opportunity_id) AS distinct
      FROM transitions WHERE job_id = ${jobId}::uuid
    `;
    expect(Number(transitions[0]!.total)).toBe(TOTAL);
    // Neither zero nor two per opportunity.
    expect(Number(transitions[0]!.distinct)).toBe(TOTAL);
  }, 90_000);

  it('holds its claim for the whole apply, so a competing loop can claim nothing', async () => {
    // The boundary itself, observed from outside. While one chunk is in flight, its `job_items`
    // rows are locked by the transaction that is still applying them, so a second loop's claim
    // query skips every one of them. Split the claim from the apply and those locks are released
    // at the claim's commit — the second loop claims the same rows and does the same work twice.
    await resetDb();
    const small = await createWorkspace('workspace-boundary');
    const jobId = await seedJob(small, 4);
    const [firstOpportunity] = await adminPrisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM opportunities WHERE workspace_id = ${small.workspaceId}::uuid
      ORDER BY id LIMIT 1
    `;

    // A blocker holding one of the chunk's opportunities pins the chunk mid-apply, so "in flight"
    // is a fact rather than a race against the scheduler.
    let releaseBlocker!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerReady!: () => void;
    const blocking = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    const blocker = adminPrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM opportunities WHERE id = ${firstOpportunity!.id}::uuid FOR UPDATE`;
        blockerReady();
        await mayRelease;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await blocking;

    const chunk = workerFor(adminPrisma).processChunk(jobId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const competing = await adminPrisma.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM job_items
      WHERE job_id = ${jobId}::uuid AND status = 'pending' AND next_attempt_at <= now()
      ORDER BY id LIMIT 50
      FOR UPDATE SKIP LOCKED
    `;
    expect(competing).toHaveLength(0);

    releaseBlocker();
    await blocker;
    const result = await chunk;

    expect(result).toMatchObject({ outcome: 'applied', claimedCount: 4, doneCount: 4 });
    expect(await adminPrisma.jobItem.count({ where: { jobId, status: 'done' } })).toBe(4);
  }, 60_000);
});
