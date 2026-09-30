import { DEFAULT_STAGE_NAMES, seedWorkspace } from '../../scripts/seed';
import { adminPrisma, disconnectTestDb, resetDb } from '../setup/testDb';

describe('seedWorkspace', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('creates exactly the requested number of opportunities', async () => {
    const { workspaceId } = await seedWorkspace(adminPrisma, {
      name: 'seed-count',
      opportunityCount: 2000,
    });

    const count = await adminPrisma.opportunity.count({ where: { workspaceId } });
    expect(count).toBe(2000);
  });

  it('builds the full 12-stage funnel in position order', async () => {
    const { workspaceId, pipelineId, stageIds } = await seedWorkspace(adminPrisma, {
      name: 'seed-stages',
      opportunityCount: 100,
    });

    const stages = await adminPrisma.stage.findMany({
      where: { workspaceId },
      orderBy: { position: 'asc' },
    });

    expect(stages).toHaveLength(12);
    expect(stages.map((s) => s.name)).toEqual(DEFAULT_STAGE_NAMES);
    expect(stages.map((s) => s.position)).toEqual([...Array(12).keys()]);
    expect(stages.every((s) => s.pipelineId === pipelineId)).toBe(true);
    expect(stageIds).toHaveLength(12);
  });

  it('places every opportunity in a stage of its own workspace pipeline', async () => {
    const { workspaceId, pipelineId } = await seedWorkspace(adminPrisma, {
      name: 'seed-integrity',
      opportunityCount: 500,
    });

    const stray = await adminPrisma.opportunity.count({
      where: {
        workspaceId,
        OR: [{ pipelineId: { not: pipelineId } }, { stage: { pipelineId: { not: pipelineId } } }],
      },
    });

    expect(stray).toBe(0);
  });

  it('spreads created_at across many months rather than stamping them all now', async () => {
    const { workspaceId } = await seedWorkspace(adminPrisma, {
      name: 'seed-spread',
      opportunityCount: 1000,
    });

    const [range] = await adminPrisma.$queryRaw<{ span_days: number }[]>`
      SELECT EXTRACT(DAY FROM (max(created_at) - min(created_at)))::int AS span_days
      FROM opportunities WHERE workspace_id = ${workspaceId}::uuid
    `;

    // Keyset pagination and the date-range filter are only meaningfully exercised by data that
    // is actually spread out; a seed that stamps every row `now()` hides both.
    expect(range?.span_days ?? 0).toBeGreaterThan(30);
  });

  it('uses a realistic spread of owners and a funnel-shaped stage distribution', async () => {
    const { workspaceId, stageIds } = await seedWorkspace(adminPrisma, {
      name: 'seed-shape',
      opportunityCount: 2000,
    });

    const owners = await adminPrisma.opportunity.findMany({
      where: { workspaceId },
      distinct: ['ownerId'],
      select: { ownerId: true },
    });
    expect(owners.length).toBeGreaterThanOrEqual(10);

    const perStage = await adminPrisma.opportunity.groupBy({
      by: ['stageId'],
      where: { workspaceId },
      _count: { _all: true },
    });
    const counts = new Map(perStage.map((row) => [row.stageId, row._count._all]));

    // Funnel shape: the first stage holds materially more than the last.
    const first = counts.get(stageIds[0]!) ?? 0;
    const last = counts.get(stageIds[11]!) ?? 0;
    expect(first).toBeGreaterThan(last);
    // Every stage is represented, so a stage-scoped filter always has something to match.
    expect(perStage.length).toBe(12);
  });

  it('refreshes planner statistics so the first benchmark is not measuring a cold optimiser', async () => {
    const { workspaceId } = await seedWorkspace(adminPrisma, {
      name: 'seed-analyze',
      opportunityCount: 1000,
    });

    const [stats] = await adminPrisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stats
      WHERE schemaname = 'public' AND tablename = 'opportunities'
    `;

    expect(Number(stats?.n ?? 0)).toBeGreaterThan(0);
    expect(workspaceId).toBeTruthy();
  });
});
