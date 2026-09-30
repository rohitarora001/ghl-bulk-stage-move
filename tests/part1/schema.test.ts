import {
  adminPrisma,
  createOpportunity,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

const UNIQUE_VIOLATION = '23505';

async function insertTransition(
  fixture: WorkspaceFixture,
  opportunityId: string,
  jobId: string | null,
): Promise<void> {
  await adminPrisma.transition.create({
    data: {
      opportunityId,
      workspaceId: fixture.workspaceId,
      fromStageId: fixture.stageIds[0]!,
      toStageId: fixture.stageIds[1]!,
      jobId,
    },
  });
}

describe('base schema', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('schema-test');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('refuses a second job-attributed transition for the same opportunity', async () => {
    const opportunity = await createOpportunity(fixture);
    const jobId = '11111111-1111-4111-8111-111111111111';

    await insertTransition(fixture, opportunity.id, jobId);

    // The partial unique index is what makes double-apply structurally impossible, rather than
    // merely detectable after the fact by the kill-resume proof query.
    await expect(insertTransition(fixture, opportunity.id, jobId)).rejects.toMatchObject({
      code: 'P2002',
    });

    const count = await adminPrisma.transition.count({ where: { jobId } });
    expect(count).toBe(1);
  });

  it('lets manual transitions stack freely for the same opportunity', async () => {
    const opportunity = await createOpportunity(fixture);

    await insertTransition(fixture, opportunity.id, null);
    await insertTransition(fixture, opportunity.id, null);
    await insertTransition(fixture, opportunity.id, null);

    const count = await adminPrisma.transition.count({
      where: { opportunityId: opportunity.id, jobId: null },
    });
    expect(count).toBe(3);
  });

  it('scopes the job-attributed constraint to one job at a time', async () => {
    const opportunity = await createOpportunity(fixture);

    await insertTransition(fixture, opportunity.id, '11111111-1111-4111-8111-111111111111');
    await insertTransition(fixture, opportunity.id, '22222222-2222-4222-8222-222222222222');

    const count = await adminPrisma.transition.count({
      where: { opportunityId: opportunity.id, NOT: { jobId: null } },
    });
    expect(count).toBe(2);
  });

  it('creates the two opportunity indexes the bulk job depends on', async () => {
    const rows = await adminPrisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'opportunities'
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    expect(byName.has('idx_opportunities_filter')).toBe(true);
    expect(byName.has('idx_opportunities_stage_list')).toBe(true);
    // Leading with workspace_id is the data-locality guarantee behind cross-tenant isolation.
    expect(byName.get('idx_opportunities_filter')).toMatch(/\(workspace_id, stage_id, owner_id/);
    expect(byName.get('idx_opportunities_stage_list')).toMatch(
      /\(workspace_id, stage_id, created_at, id\)/,
    );
  });

  it('records the transitions uniqueness constraint as a partial index', async () => {
    const [row] = await adminPrisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'transitions_job_opportunity_uq'
    `;

    expect(row?.indexdef).toMatch(/UNIQUE INDEX/);
    expect(row?.indexdef).toMatch(/WHERE \(job_id IS NOT NULL\)/);
  });

  it('defaults a new opportunity to version 1', async () => {
    const opportunity = await createOpportunity(fixture);

    expect(opportunity.version).toBe(1);
  });

  it('rejects two stages sharing a position within one pipeline', async () => {
    await expect(
      adminPrisma.stage.create({
        data: {
          workspaceId: fixture.workspaceId,
          pipelineId: fixture.pipelineId,
          name: 'duplicate position',
          position: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

// Kept so the constant documents the underlying SQLSTATE the Prisma code maps from.
export { UNIQUE_VIOLATION };
