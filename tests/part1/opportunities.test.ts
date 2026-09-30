import request from 'supertest';
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
 * Part 1's three endpoints.
 *
 * The listing is keyset, not OFFSET. At 500k rows an OFFSET walk re-scans everything it has
 * already returned on every page, and — worse for correctness — a row inserted or moved during
 * the walk shifts every later page, so the caller silently skips or repeats rows. A keyset cursor
 * on `(created_at, id)` is stable under concurrent writes and costs the same on page 500 as on
 * page 1.
 */

const app = createApp();

function api(fixture: WorkspaceFixture) {
  return {
    create: (body: unknown) =>
      request(app)
        .post('/opportunities')
        .set('X-Workspace-Id', fixture.workspaceId)
        .send(body as object),
    move: (id: string, body: unknown) =>
      request(app)
        .post(`/opportunities/${id}/move`)
        .set('X-Workspace-Id', fixture.workspaceId)
        .send(body as object),
    list: (stageId: string, query: string) =>
      request(app)
        .get(`/stages/${stageId}/opportunities${query}`)
        .set('X-Workspace-Id', fixture.workspaceId),
  };
}

const OWNER = '11111111-1111-4111-8111-111111111111';

describe('POST /opportunities', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('creates at version 1', async () => {
    const response = await api(fixture).create({
      pipelineId: fixture.pipelineId,
      stageId: fixture.stageIds[0]!,
      name: 'Acme renewal',
      value: 2500.5,
      ownerId: OWNER,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      stageId: fixture.stageIds[0]!,
      name: 'Acme renewal',
      status: 'open',
      version: 1,
    });
    // Serialised as a string, not a float: `value` is NUMERIC(14,2) and a JSON number would
    // round-trip through a double.
    expect(response.body.value).toBe('2500.5');

    const stored = await adminPrisma.opportunity.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(stored.workspaceId).toBe(fixture.workspaceId);
    expect(stored.version).toBe(1);
  });

  it('rejects a stage that does not belong to the named pipeline', async () => {
    const otherWorkspace = await createWorkspace('workspace-b');

    const response = await api(fixture).create({
      pipelineId: fixture.pipelineId,
      stageId: otherWorkspace.stageIds[0]!,
      name: 'Mismatched',
      value: 1,
      ownerId: OWNER,
    });

    expect(response.status).toBe(400);
    expect(await adminPrisma.opportunity.count()).toBe(0);
  });
});

describe('POST /opportunities/:id/move', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  it('bumps the version and writes a transition attributed to no job', async () => {
    const opportunity = await createOpportunity(fixture, { stageId: fixture.stageIds[0]! });

    const response = await api(fixture).move(opportunity.id, {
      targetStageId: fixture.stageIds[1]!,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ stageId: fixture.stageIds[1]!, version: 2 });

    const transitions = await adminPrisma.transition.findMany({
      where: { opportunityId: opportunity.id },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      fromStageId: fixture.stageIds[0]!,
      toStageId: fixture.stageIds[1]!,
      jobId: null,
    });
  });

  it('answers 409 on a stale expectedVersion and changes nothing', async () => {
    const opportunity = await createOpportunity(fixture, { stageId: fixture.stageIds[0]! });

    const response = await api(fixture).move(opportunity.id, {
      targetStageId: fixture.stageIds[1]!,
      expectedVersion: 99,
    });

    expect(response.status).toBe(409);

    const unchanged = await adminPrisma.opportunity.findUniqueOrThrow({
      where: { id: opportunity.id },
    });
    expect(unchanged.stageId).toBe(fixture.stageIds[0]!);
    expect(unchanged.version).toBe(1);
    expect(await adminPrisma.transition.count()).toBe(0);
  });

  it('answers 404 for an opportunity in another workspace', async () => {
    const other = await createWorkspace('workspace-b');
    const opportunity = await createOpportunity(other, { stageId: other.stageIds[0]! });

    const response = await api(fixture).move(opportunity.id, {
      targetStageId: fixture.stageIds[1]!,
    });

    expect(response.status).toBe(404);
  });
});

describe('GET /stages/:stageId/opportunities', () => {
  let fixture: WorkspaceFixture;
  const TOTAL = 250;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
  });

  it('walks every row exactly once across pages, including ties on created_at', async () => {
    // 7 distinct timestamps across 250 rows, so the groups are 35-36 rows and a 100-row page
    // boundary lands INSIDE a tied group rather than neatly between two. That is the only shape
    // that can catch a cursor carrying `created_at` alone: with evenly divisible groups such a
    // cursor happens to be correct, and the test would pass for the wrong reason.
    await adminPrisma.$executeRaw`
      INSERT INTO opportunities (workspace_id, pipeline_id, stage_id, name, value, owner_id, created_at)
      SELECT ${fixture.workspaceId}::uuid, ${fixture.pipelineId}::uuid, ${fixture.stageIds[0]!}::uuid,
             'row ' || g, 100, gen_random_uuid(),
             now() - (interval '1 minute' * (g % 7))
      FROM generate_series(1, ${TOTAL}) g
    `;
    // A row in a different stage, to prove the listing is scoped.
    await createOpportunity(fixture, { stageId: fixture.stageIds[1]! });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
      const response = await api(fixture).list(fixture.stageIds[0]!, query);
      expect(response.status).toBe(200);
      for (const row of response.body.items as { id: string }[]) seen.push(row.id);
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);

    const expected = await adminPrisma.opportunity.findMany({
      where: { stageId: fixture.stageIds[0]! },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(seen).toEqual(expected.map((row) => row.id));
  });

  it('returns no cursor on the last page', async () => {
    await createOpportunity(fixture, { stageId: fixture.stageIds[0]! });

    const response = await api(fixture).list(fixture.stageIds[0]!, '?limit=100');

    expect(response.body.items).toHaveLength(1);
    expect(response.body.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor rather than silently starting over', async () => {
    const response = await api(fixture).list(fixture.stageIds[0]!, '?cursor=not-a-cursor');

    expect(response.status).toBe(400);
  });

  it('answers 404 for a stage in another workspace', async () => {
    const other = await createWorkspace('workspace-b');

    const response = await api(fixture).list(other.stageIds[0]!, '?limit=10');

    expect(response.status).toBe(404);
  });
});
