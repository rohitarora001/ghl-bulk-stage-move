import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * The claim query must cost what is left, not what is done.
 *
 * `job_items.status` is the cursor, which is only true if reading it is cheap. Measured on the
 * 500 000-row benchmark dataset the claim walked `job_items_pkey` and filtered: 1 582 buffers at
 * 0 done, 91 828 at 45 000 done, 91 837 with a previous job's 50 000 rows also in the table. The
 * job got slower the more of it was finished — the exact shape of an O(offset) cursor, arrived at
 * without ever persisting an offset. `job_items_claimable_idx (job_id, next_attempt_at, id)`
 * cannot fix it: the range predicate on `next_attempt_at` puts `id` out of reach as a sort key,
 * so the planner will not use it to satisfy `ORDER BY id`.
 *
 * `job_items_claim_order_idx (job_id, id) WHERE status = 'pending'` is the right shape, and this
 * test is what keeps it: an index nothing asserts on is an index a later migration drops.
 */

const TOTAL = 50_000;
const DONE = 45_000;
const CHUNK = 500;

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

/** The exact statement `claimAndApplyChunk` runs, with its parameters inlined for EXPLAIN. */
async function explainClaim(jobId: string): Promise<PlanNode> {
  const rows = await adminPrisma.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id, opportunity_id, expected_version
    FROM job_items
    WHERE job_id = '${jobId}'::uuid
      AND status = 'pending'
      AND next_attempt_at <= now()
    ORDER BY id
    LIMIT ${CHUNK}
    FOR UPDATE SKIP LOCKED
  `);
  return rows[0]!['QUERY PLAN'][0]!.Plan;
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

describe('the chunk claim', () => {
  let fixture: WorkspaceFixture;
  let jobId: string;

  beforeAll(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');

    await adminPrisma.$executeRawUnsafe(`
      INSERT INTO opportunities (workspace_id, pipeline_id, stage_id, name, value, status, owner_id)
      SELECT '${fixture.workspaceId}'::uuid, '${fixture.pipelineId}'::uuid,
             '${fixture.stageIds[0]}'::uuid, 'opp ' || n, 100.00, 'open'::opportunity_status,
             gen_random_uuid()
      FROM generate_series(1, ${TOTAL}) AS n
    `);
    const job = await adminPrisma.job.create({
      data: {
        workspaceId: fixture.workspaceId,
        idempotencyKey: 'claim-plan',
        filter: {},
        targetStageId: fixture.stageIds[1]!,
        totalCount: TOTAL,
        matchedCount: TOTAL,
      },
    });
    jobId = job.id;
    await adminPrisma.$executeRawUnsafe(`
      INSERT INTO job_items (job_id, opportunity_id, expected_version, status)
      SELECT '${jobId}'::uuid, o.id, o.version, 'pending'::job_item_status
      FROM opportunities o
      WHERE o.workspace_id = '${fixture.workspaceId}'::uuid
    `);
    // The job is most of the way through: the rows a pkey scan would have to walk past.
    await adminPrisma.$executeRawUnsafe(`
      UPDATE job_items SET status = 'done'
      WHERE id IN (
        SELECT id FROM job_items WHERE job_id = '${jobId}'::uuid ORDER BY id LIMIT ${DONE}
      )
    `);
    await adminPrisma.$executeRawUnsafe(`ANALYZE job_items`);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('reads only pending rows, however many are already done', async () => {
    const plan = await explainClaim(jobId);
    const nodes = flatten(plan);

    const indexNames = nodes.map((node) => node['Index Name']).filter(Boolean);
    expect(indexNames).toContain('job_items_claim_order_idx');

    // The whole finding in one assertion: a filtered scan discards the finished prefix row by row,
    // and that prefix only ever grows.
    const discarded = nodes.reduce((sum, node) => sum + (node['Rows Removed by Filter'] ?? 0), 0);
    expect(discarded).toBe(0);
  });
});
